// The plugin as Obsidian runs it (Obsidian API mocked), against the offline engine.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { App, Editor, MarkdownView, TFile, TFolder, notices, settings } from './obsidian-mock'; // the same module src/ gets for 'obsidian' (vitest.config.ts)
import RenorPlugin, { AskModal, SECRET_ID } from '../src/main';
import { fetchHttp } from '../src/mcp';
import { engineBuilt, startEngine, type Engine } from './engine';

const run = engineBuilt() ? describe : describe.skip;

run('the plugin in a mocked Obsidian', () => {
  let engine: Engine;
  const app = new App();
  let plugin: RenorPlugin;
  const menuItems = (folder: TFolder) => {
    const items: Array<{ title: string; click: () => unknown }> = [];
    const menu = { addItem(cb: (i: any) => void) {
      const item: any = { setTitle(t: string) { item.title = t; return item; }, setIcon() { return item; }, onClick(c: () => unknown) { item.click = c; return item; } };
      cb(item); items.push(item);
    } };
    app.workspace.trigger('file-menu', menu, folder);
    return items;
  };
  const searchRenor = async (q: string) => JSON.stringify((await plugin.client()!.call('get_context', { query: q })).memories ?? []);

  beforeAll(async () => {
    engine = await startEngine();
    app.vault.files.set('Work/plan.md', '# Plan\nThe Heron launch is on November 3.\n');
    app.vault.files.set('Work/Private/salary.md', '# Salary\nMy kestrel bonus number.\n');
    app.vault.folders.add('Work'); app.vault.folders.add('Work/Private');
    plugin = new RenorPlugin(app as any, {} as any);
    plugin.http = fetchHttp;
    await plugin.onload();
  });
  afterAll(async () => { plugin?.onunload(); await engine?.close(); });

  test('without a key nothing is sent, and the status bar says what to do', () => {
    expect(plugin.sync).toBeUndefined();
    expect((plugin as any).status.text).toBe('Renor: add an API key');
  });

  test('the key goes to secret storage, never to data.json', async () => {
    plugin.settings.serverUrl = engine.url;
    plugin.setApiKey(engine.token);
    plugin.restart();
    await plugin.sync!.idle();
    expect(app.secretStorage.getSecret(SECRET_ID)).toBe(engine.token);
    await plugin.saveState();
    expect(JSON.stringify((plugin as any).data)).not.toContain(engine.token);
    expect(Object.keys(plugin.syncState.notes)).toEqual([]); // still nothing shared
  });

  test('"Share with Renor" on a folder syncs it; a private subfolder stays out', async () => {
    await plugin.markPrivate('Work/Private');
    const [item] = menuItems(new TFolder('Work'));
    expect(item.title).toBe('Share with Renor');
    await item.click();
    expect(plugin.settings.sharedFolders).toEqual(['Work']);
    expect(plugin.sync!.last).toMatchObject({ synced: 1, failed: [], skipped: [] });
    expect(Object.keys(plugin.syncState.notes)).toEqual(['Work/plan.md']);
    expect(await searchRenor('Heron launch')).toContain('Work/plan.md');
    expect(await searchRenor('kestrel')).toBe('[]');
    expect(menuItems(new TFolder('Work'))[0].title).toBe('Stop sharing with Renor');
  });

  test('vault events keep Renor in sync', async () => {
    await app.vault.modify(new TFile('Work/plan.md'), '# Plan\nThe Heron launch moved to November 10.\n');
    await app.vault.create('Work/notes.md', '# Notes\nOsprey is the codename for v2.\n');
    await plugin.sync!.idle();
    expect(await searchRenor('Heron November')).toContain('November 10');
    expect(await searchRenor('Heron November')).not.toContain('November 3');
    expect(await searchRenor('Osprey')).toContain('Work/notes.md');
    await app.vault.rename(new TFile('Work/notes.md'), 'Work/codenames.md');
    await app.vault.delete(new TFile('Work/plan.md'));
    await plugin.sync!.idle();
    expect(Object.keys(plugin.syncState.notes).sort()).toEqual(['Work/codenames.md']);
    expect(await searchRenor('Heron')).toBe('[]');
  });

  test('"Pull what agents saved" writes them into the Renor folder, and they are not synced back', async () => {
    await plugin.client()!.call('remember', { statement: 'Claude Code decided the plugin keeps API keys in secret storage.' });
    await plugin.pull(true);
    const pulled = [...app.vault.files.keys()].filter(p => p.startsWith('Renor/'));
    expect(pulled).toHaveLength(1);
    expect(app.vault.files.get(pulled[0])).toContain('keeps API keys in secret storage');
    await plugin.sync!.idle();
    expect(Object.keys(plugin.syncState.notes).some(p => p.startsWith('Renor/'))).toBe(false);
  });

  test('Ask Renor answers from the vault and inserts into the note', async () => {
    const editor = new Editor('What is Osprey?');
    app.workspace.active = new MarkdownView(editor);
    settings.length = 0;
    const modal = new AskModal(app as any, plugin);
    modal.open();
    await new Promise(r => setTimeout(r, 300));
    const output = (modal.contentEl as any).children[0].allText() as string;
    expect(output).toContain('Osprey is the codename for v2.');
    expect(output).toContain('[[Work/codenames]]');
    const insert = settings.flatMap(s => s.buttons).find(b => b.text === 'Insert into note')!;
    expect(insert.disabled).toBe(false);
    insert.click();
    expect(editor.inserted[0]).toContain('Osprey is the codename for v2.');
  });

  test('stop sharing withdraws the folder', async () => {
    await menuItems(new TFolder('Work'))[0].click();
    expect(plugin.syncState.notes).toEqual({});
    expect(await searchRenor('Osprey')).toBe('[]');
    expect(notices.at(-1)).toMatch(/withdrawn/);
  });
});
