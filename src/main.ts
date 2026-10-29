// Obsidian glue: settings, the folder chooser, vault events → SyncEngine, the Renor folder, and the Ask Renor command.
// The logic lives in sync.ts, sharing.ts, inbox.ts and ask.ts, which never import Obsidian.
import {
  App, ButtonComponent, FuzzySuggestModal, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder,
  normalizePath, requestUrl,
} from 'obsidian';
import { HOSTED_URL, RenorClient, checkServerUrl, type HttpFn } from './mcp';
import { normalizeFolder, shareDecision, type SharingRules } from './sharing';
import { ImportToolsBackend, SyncEngine, importLabel, type SyncReport, type SyncState } from './sync';
import { pullInbox, type InboxState, type NoteWriter } from './inbox';
import { CONFIG_PATH, parseConfig, sameFolders, serializeConfig } from './config';
import { askRenor, renderAnswer } from './ask';

export interface RenorSettings {
  /** MCP endpoint: hosted by default, or a self-hosted Renor HTTP server's /mcp. */
  serverUrl: string;
  sharedFolders: string[];
  privateFolders: string[];
  renorFolder: string;
  /** Minutes between pulls of what agents saved into the Renor folder; 0 pulls only on command. */
  pullMinutes: number;
}
export const DEFAULT_SETTINGS: RenorSettings = {
  serverUrl: HOSTED_URL,
  sharedFolders: [],
  privateFolders: [],
  renorFolder: 'Renor',
  pullMinutes: 15,
};
interface PluginData { settings: RenorSettings; sync: SyncState; inbox: InboxState }

/** The API key lives in Obsidian's secret storage, never in data.json (which people sync and commit). */
export const SECRET_ID = 'renor-api-key';

const obsidianHttp: HttpFn = async req => {
  const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = String(v);
  return { status: res.status, headers, text: res.text };
};

export default class RenorPlugin extends Plugin {
  settings: RenorSettings = { ...DEFAULT_SETTINGS };
  syncState: SyncState = { notes: {} };
  inboxState: InboxState = { written: {} };
  sync: SyncEngine | undefined;
  /** Injected by tests; Obsidian's requestUrl otherwise. */
  http: HttpFn = obsidianHttp;
  private pullTimer: number | undefined;
  private status: HTMLElement | undefined;

  async onload(): Promise<void> {
    await this.loadState();
    this.addSettingTab(new RenorSettingTab(this.app, this));
    this.status = this.addStatusBarItem();

    this.addCommand({ id: 'ask', name: 'Ask Renor', callback: () => new AskModal(this.app, this).open() });
    this.addCommand({ id: 'sync-now', name: 'Sync shared folders now', callback: () => void this.reconcile(true) });
    this.addCommand({ id: 'pull-saved', name: 'Pull what agents saved into the Renor folder', callback: () => void this.pull(true) });

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFolder)) return;
      const path = file.isRoot() ? '/' : file.path;
      const shared = this.settings.sharedFolders.includes(path);
      menu.addItem(item => item.setTitle(shared ? 'Stop sharing with Renor' : 'Share with Renor').setIcon('brain')
        .onClick(() => (shared ? this.unshareFolder(path) : this.shareFolder(path))));
    }));

    this.app.workspace.onLayoutReady(() => {
      // Registered after layout is ready, so opening the vault does not replay a create event for every note.
      this.registerEvent(this.app.vault.on('create', f => { if (f instanceof TFile) { this.sync?.changed(f.path); this.configTouched(f.path); } }));
      this.registerEvent(this.app.vault.on('modify', f => { if (f instanceof TFile) { this.sync?.changed(f.path); this.configTouched(f.path); } }));
      this.registerEvent(this.app.vault.on('delete', f => { if (f instanceof TFile) void this.sync?.deleted(f.path); }));
      this.registerEvent(this.app.vault.on('rename', (f, old) => { if (f instanceof TFile) void this.sync?.renamed(f.path, old); }));
      void this.loadConfigFile(true).then(() => this.restart());
    });
  }

  onunload(): void {
    this.sync?.stop();
    if (this.pullTimer !== undefined) window.clearInterval(this.pullTimer);
  }

  apiKey(): string { return this.app.secretStorage.getSecret(SECRET_ID) ?? ''; }
  setApiKey(key: string): void { this.app.secretStorage.setSecret(SECRET_ID, key.trim()); }

  rules(): SharingRules {
    return { ...this.settings, configDir: this.app.vault.configDir };
  }

  /** Why there is no client, or undefined when one can be made. */
  connectionProblem(): string | undefined {
    if (!this.apiKey()) return 'Renor: add an API key';
    try { checkServerUrl(this.serverUrl()); } catch (err) { return `Renor: ${(err as Error).message}`; }
    return undefined;
  }

  private serverUrl(): string { return this.settings.serverUrl.trim() || HOSTED_URL; }

  /** A client, or undefined without a key or with a server address the key may not be sent to. */
  client(): RenorClient | undefined {
    if (this.connectionProblem()) return undefined;
    return new RenorClient(this.serverUrl(), this.apiKey(), this.http);
  }

  /** Rebuilds the sync engine and the pull timer from the current settings and key, then reconciles. */
  restart(): void {
    this.sync?.stop();
    if (this.pullTimer !== undefined) { window.clearInterval(this.pullTimer); this.pullTimer = undefined; }
    const client = this.client();
    if (!client) { this.sync = undefined; this.setStatus(this.connectionProblem() ?? 'Renor: not connected'); return; }
    const backend = new ImportToolsBackend(client, importLabel(this.app.vault.getName()), this.syncState, () => this.saveState());
    this.sync = new SyncEngine(
      {
        listMarkdown: () => this.app.vault.getMarkdownFiles().map(f => f.path),
        read: async path => {
          const file = this.app.vault.getFileByPath(path);
          if (!file) throw new Error('note not found');
          return this.app.vault.cachedRead(file);
        },
      },
      backend, () => this.rules(), () => Object.keys(this.syncState.notes),
    );
    void this.reconcile(false);
    if (this.settings.pullMinutes > 0) {
      this.pullTimer = window.setInterval(() => void this.pull(false), this.settings.pullMinutes * 60_000);
      this.registerInterval(this.pullTimer);
    }
  }

  async reconcile(loud: boolean): Promise<SyncReport | undefined> {
    if (!this.sync) { if (loud) new Notice(this.connectionProblem() ?? 'Renor: not connected'); return undefined; }
    this.setStatus('Renor: syncing…');
    const report = await this.sync.reconcile();
    const shared = Object.keys(this.syncState.notes).length;
    this.setStatus(this.settings.sharedFolders.length === 0 ? 'Renor: nothing shared' : `Renor: ${shared} ${shared === 1 ? 'note' : 'notes'} shared`);
    const problems = report.failed.length + report.skipped.length;
    if (loud || report.failed.length > 0) {
      new Notice(`Renor: ${report.synced} synced, ${report.removed} withdrawn${problems ? `, ${problems} not synced (see settings)` : ''}`);
    }
    return report;
  }

  async pull(loud: boolean): Promise<void> {
    const client = this.client();
    if (!client) { if (loud) new Notice(this.connectionProblem() ?? 'Renor: not connected'); return; }
    try {
      const report = await pullInbox(client, this.noteWriter(), normalizePath(this.settings.renorFolder), this.inboxState);
      await this.saveState();
      if (loud || report.written > 0) new Notice(`Renor: ${report.written} new, ${report.updated} updated in ${this.settings.renorFolder}/`);
    } catch (err) {
      if (loud) new Notice(`Renor: ${(err as Error).message}`);
    }
  }

  noteWriter(): NoteWriter {
    const vault = this.app.vault;
    return {
      exists: async path => vault.getAbstractFileByPath(path) !== null,
      read: async path => { const f = vault.getFileByPath(path); return f ? vault.read(f) : ''; },
      write: async (path, text) => {
        const f = vault.getFileByPath(path);
        if (f) await vault.modify(f, text); else await vault.create(path, text);
      },
      ensureFolder: async path => { if (!vault.getAbstractFileByPath(path)) await vault.createFolder(path); },
    };
  }

  async shareFolder(path: string): Promise<void> {
    const folder = path === '/' ? '/' : normalizeFolder(path);
    if (!this.settings.sharedFolders.includes(folder)) this.settings.sharedFolders.push(folder);
    this.settings.privateFolders = this.settings.privateFolders.filter(f => f !== folder);
    await this.saveState();
    await this.writeConfigFile();
    await this.reconcile(true);
  }

  async unshareFolder(path: string): Promise<void> {
    this.settings.sharedFolders = this.settings.sharedFolders.filter(f => f !== path);
    await this.saveState();
    await this.writeConfigFile();
    await this.reconcile(true);
  }

  async markPrivate(path: string): Promise<void> {
    const folder = normalizeFolder(path);
    if (folder && !this.settings.privateFolders.includes(folder)) this.settings.privateFolders.push(folder);
    await this.saveState();
    await this.writeConfigFile();
    await this.reconcile(true);
  }

  async removePrivate(folder: string): Promise<void> {
    this.settings.privateFolders = this.settings.privateFolders.filter(f => f !== folder);
    await this.saveState();
    await this.writeConfigFile();
    await this.reconcile(false);
  }

  private configTouched(path: string): void { if (path === CONFIG_PATH) void this.loadConfigFile(false); }

  /** Applies renor.json to the settings (the file wins when it exists), or writes it from the settings when it does not. */
  async loadConfigFile(startup: boolean): Promise<void> {
    const file = this.app.vault.getFileByPath(CONFIG_PATH);
    if (!file) { await this.writeConfigFile(); return; }
    let parsed;
    try { parsed = parseConfig(await this.app.vault.read(file), this.settings.renorFolder, this.app.vault.configDir); }
    catch (err) { new Notice(`Renor: ${(err as Error).message}; keeping the folders as they are`); return; }
    if (parsed.ignored.length > 0) new Notice(`Renor: ignored in ${CONFIG_PATH}: ${parsed.ignored.join('; ')}`);
    const before = { sharedFolders: this.settings.sharedFolders, privateFolders: this.settings.privateFolders };
    // A file edit never makes a private folder shareable: dropped entries stay private until removed in Settings.
    const kept = before.privateFolders.filter(f => !parsed.config.privateFolders.includes(f));
    if (kept.length > 0) {
      parsed.config.privateFolders = [...parsed.config.privateFolders, ...kept];
      new Notice(`Renor: ${CONFIG_PATH} dropped ${kept.join(', ')} from the private folders. ${kept.length === 1 ? 'It stays' : 'They stay'} private until you remove ${kept.length === 1 ? 'it' : 'them'} in Settings > Renor.`);
    }
    if (sameFolders(before, parsed.config)) { if (kept.length > 0) await this.writeConfigFile(); return; }
    this.settings.sharedFolders = parsed.config.sharedFolders;
    this.settings.privateFolders = parsed.config.privateFolders;
    await this.saveState();
    if (kept.length > 0) await this.writeConfigFile();
    if (!sameFolders({ sharedFolders: before.sharedFolders, privateFolders: [] }, { sharedFolders: parsed.config.sharedFolders, privateFolders: [] })) {
      const shared = parsed.config.sharedFolders;
      new Notice(`Renor: shared folders from ${CONFIG_PATH}: ${shared.length ? shared.map(f => (f === '/' ? '/ (whole vault)' : f)).join(', ') : 'none'}`);
    }
    if (!startup) await this.reconcile(false);
  }

  /** Writes the settings to renor.json unless it already says the same. */
  async writeConfigFile(): Promise<void> {
    const text = serializeConfig(this.settings);
    const file = this.app.vault.getFileByPath(CONFIG_PATH);
    try {
      if (!file) await this.app.vault.create(CONFIG_PATH, text);
      else if (await this.app.vault.read(file) !== text) {
        let same = false;
        try { same = sameFolders(parseConfig(await this.app.vault.read(file), this.settings.renorFolder, this.app.vault.configDir).config, this.settings); } catch { /* unreadable: replace */ }
        if (!same) await this.app.vault.modify(file, text);
      }
    } catch (err) { new Notice(`Renor: could not write ${CONFIG_PATH}: ${(err as Error).message}`); }
  }

  async loadState(): Promise<void> {
    const data = (await this.loadData()) as Partial<PluginData> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    this.syncState = { notes: { ...(data?.sync?.notes ?? {}) } };
    this.inboxState = { written: { ...(data?.inbox?.written ?? {}) } };
  }

  async saveState(): Promise<void> {
    const data: PluginData = { settings: this.settings, sync: this.syncState, inbox: this.inboxState };
    await this.saveData(data);
  }

  private setStatus(text: string): void { this.status?.setText(text); }

  /** Why one note is or is not shared, for the settings page. */
  explain(path: string): string {
    const d = shareDecision(path, this.rules());
    return d.shared ? 'shared' : d.reason;
  }
}

class FolderPicker extends FuzzySuggestModal<TFolder> {
  constructor(app: App, private readonly onPick: (folder: TFolder) => void) { super(app); this.setPlaceholder('Choose a folder'); }
  getItems(): TFolder[] {
    return this.app.vault.getAllLoadedFiles().filter((f: TAbstractFile): f is TFolder => f instanceof TFolder);
  }
  getItemText(folder: TFolder): string { return folder.isRoot() ? '/ (whole vault)' : folder.path; }
  onChooseItem(folder: TFolder): void { this.onPick(folder); }
}

export class AskModal extends Modal {
  constructor(app: App, private readonly plugin: RenorPlugin) { super(app); }

  onOpen(): void {
    this.setTitle('Ask Renor');
    const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
    let question = editor?.getSelection() ?? '';
    let answer = '';
    let insert: ButtonComponent | undefined;
    const output = this.contentEl.createEl('div', { cls: 'renor-answer' });
    const ask = async () => {
      const client = this.plugin.client();
      if (!client) { output.setText(this.plugin.connectionProblem() ?? 'Renor: not connected'); return; }
      if (!question.trim()) return;
      output.setText('Asking…');
      try {
        answer = renderAnswer(question, await askRenor(client, question), importLabel(this.app.vault.getName()));
        output.empty();
        const list = output.createEl('ul');
        for (const line of answer.split('\n')) list.createEl('li', { text: line.replace(/^- /, '') });
        insert?.setDisabled(!editor);
      } catch (err) {
        output.setText((err as Error).message);
      }
    };
    new Setting(this.contentEl).addText(t => {
      t.setPlaceholder('What does Renor know about…').setValue(question).onChange(v => { question = v; });
      t.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') void ask(); });
      window.setTimeout(() => t.inputEl.focus(), 0);
    }).addButton(b => b.setButtonText('Ask').setCta().onClick(() => void ask()));
    this.contentEl.appendChild(output);
    new Setting(this.contentEl).addButton(b => {
      insert = b.setButtonText('Insert into note').setDisabled(true).onClick(() => {
        editor?.replaceSelection(`${question}\n${answer}\n`);
        this.close();
      });
    });
    if (question.trim()) void ask();
  }

  onClose(): void { this.contentEl.empty(); }
}

export class RenorSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: RenorPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();

    new Setting(containerEl).setName('Connection').setHeading();
    new Setting(containerEl).setName('API key')
      .setDesc('From the Renor dashboard. Kept in Obsidian\'s secret storage, not in the plugin\'s data file.')
      .addText(t => {
        t.inputEl.type = 'password';
        t.setPlaceholder(p.apiKey() ? '•••••••• (saved)' : 'Paste your key').onChange(v => { p.setApiKey(v); });
        t.inputEl.addEventListener('blur', () => p.restart());
      });
    new Setting(containerEl).setName('Server')
      .setDesc(`Hosted Renor is ${HOSTED_URL}. For your own Renor server, its https:// /mcp address (plain http:// only on this computer).`)
      .addText(t => t.setPlaceholder(HOSTED_URL).setValue(p.settings.serverUrl).onChange(async v => {
        const url = v.trim() || HOSTED_URL;
        try { checkServerUrl(url); } catch { return; } // keep the last address the key may go to; Check says why
        p.settings.serverUrl = url;
        await p.saveState();
      }));
    new Setting(containerEl).setName('Check connection').addButton(b => b.setButtonText('Check').onClick(async () => {
      const client = p.client();
      if (!client) { new Notice(p.connectionProblem() ?? 'Renor: not connected'); return; }
      try { await client.call('memory_status'); new Notice('Renor: connected'); p.restart(); }
      catch (err) { new Notice(`Renor: ${(err as Error).message}`); }
    }));

    new Setting(containerEl).setName('Shared folders').setHeading()
      .setDesc('Nothing leaves this vault until you choose a folder. Notes in it reach your agents through Renor and stay in sync as you edit, move or delete them.');
    for (const folder of p.settings.sharedFolders) {
      new Setting(containerEl).setName(folder === '/' ? '/ (whole vault)' : folder)
        .addExtraButton(b => b.setIcon('x').setTooltip('Stop sharing (withdraws its notes from Renor)').onClick(async () => {
          await p.unshareFolder(folder); this.display();
        }));
    }
    new Setting(containerEl).addButton(b => b.setButtonText('Add shared folder').onClick(() => {
      new FolderPicker(this.app, async f => { await p.shareFolder(f.isRoot() ? '/' : f.path); this.display(); }).open();
    }));

    new Setting(containerEl).setName('Private folders').setHeading()
      .setDesc(`Never shared, even inside a shared folder. The ${p.settings.renorFolder}/ folder and Obsidian's settings are never shared either.`);
    for (const folder of p.settings.privateFolders) {
      new Setting(containerEl).setName(folder).addExtraButton(b => b.setIcon('x').setTooltip('Remove').onClick(async () => {
        await p.removePrivate(folder); this.display();
      }));
    }
    new Setting(containerEl).addButton(b => b.setButtonText('Add private folder').onClick(() => {
      new FolderPicker(this.app, async f => { if (!f.isRoot()) { await p.markPrivate(f.path); this.display(); } }).open();
    }));

    new Setting(containerEl).setName('What agents saved').setHeading();
    new Setting(containerEl).setName('Renor folder')
      .setDesc('What your agents save to Renor is copied here as notes. A one-way copy: edits here are not sent back.')
      .addText(t => t.setValue(p.settings.renorFolder).onChange(async v => {
        p.settings.renorFolder = normalizeFolder(v) || 'Renor';
        await p.saveState();
      }));
    new Setting(containerEl).setName('Pull every (minutes)').setDesc('0: only when you run "Pull what agents saved".')
      .addText(t => t.setValue(String(p.settings.pullMinutes)).onChange(async v => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) { p.settings.pullMinutes = Math.floor(n); await p.saveState(); }
      }));

    const last = p.sync?.last;
    if (last && (last.skipped.length || last.failed.length)) {
      new Setting(containerEl).setName('Not synced').setHeading();
      for (const s of last.skipped) new Setting(containerEl).setName(s.path).setDesc(s.reason);
      for (const f of last.failed) new Setting(containerEl).setName(f.path).setDesc(f.error);
    }
  }

  hide(): void { this.plugin.restart(); }
}
