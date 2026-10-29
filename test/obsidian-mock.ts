// Just enough of the Obsidian API for the plugin's tests: an in-memory vault that emits create/modify/delete/rename,
// a workspace, secret storage, and Setting/Modal/Notice stand-ins that record what they were given.
type Handler = (...args: any[]) => unknown;

class Emitter {
  private handlers = new Map<string, Handler[]>();
  on(name: string, cb: Handler) { (this.handlers.get(name) ?? this.handlers.set(name, []).get(name)!).push(cb); return { name, cb }; }
  trigger(name: string, ...args: unknown[]) { for (const cb of this.handlers.get(name) ?? []) cb(...args); }
}

export class TAbstractFile { constructor(public path: string) {} get name() { return this.path.split('/').pop()!; } }
export class TFile extends TAbstractFile { extension = 'md'; }
export class TFolder extends TAbstractFile { isRoot() { return this.path === '/'; } }

export class Vault extends Emitter {
  files = new Map<string, string>();
  folders = new Set<string>(['/']);
  configDir = '.obsidian';
  constructor(private name = 'Test Vault') { super(); }
  getName() { return this.name; }
  getMarkdownFiles() { return [...this.files.keys()].filter(p => p.endsWith('.md')).map(p => new TFile(p)); }
  getFileByPath(p: string) { return this.files.has(p) ? new TFile(p) : null; }
  getAbstractFileByPath(p: string) { return this.files.has(p) ? new TFile(p) : this.folders.has(p) ? new TFolder(p) : null; }
  getAllLoadedFiles() { return [...[...this.folders].map(p => new TFolder(p)), ...this.getMarkdownFiles()]; }
  async read(f: TFile) { return this.files.get(f.path)!; }
  async cachedRead(f: TFile) { return this.files.get(f.path)!; }
  async create(p: string, text: string) {
    if (this.files.has(p)) throw new Error('File already exists.');
    this.files.set(p, text); this.trigger('create', new TFile(p)); return new TFile(p);
  }
  async modify(f: TFile, text: string) { this.files.set(f.path, text); this.trigger('modify', f); }
  async createFolder(p: string) { this.folders.add(p); }
  async delete(f: TFile) { this.files.delete(f.path); this.trigger('delete', f); }
  async rename(f: TFile, to: string) { const t = this.files.get(f.path)!; this.files.delete(f.path); this.files.set(to, t); this.trigger('rename', new TFile(to), f.path); }
}

export class SecretStorage {
  secrets = new Map<string, string>();
  setSecret(id: string, s: string) { this.secrets.set(id, s); }
  getSecret(id: string) { return this.secrets.get(id) ?? null; }
  listSecrets() { return [...this.secrets.keys()]; }
}

export class Editor {
  constructor(public selection = '', public inserted: string[] = []) {}
  getSelection() { return this.selection; }
  replaceSelection(t: string) { this.inserted.push(t); }
}
export class MarkdownView { constructor(public editor: Editor) {} }

export class Workspace extends Emitter {
  active: MarkdownView | null = null;
  onLayoutReady(cb: () => void) { cb(); }
  getActiveViewOfType() { return this.active; }
}

export class App {
  vault = new Vault();
  workspace = new Workspace();
  secretStorage = new SecretStorage();
}

export const notices: string[] = [];
export class Notice { constructor(public message: string) { notices.push(message); } }

class El {
  text = '';
  children: El[] = [];
  style: Record<string, string> = {};
  type = '';
  private listeners = new Map<string, Handler>();
  setText(t: string) { this.text = t; }
  createEl(_tag: string, o?: { text?: string }) { const el = new El(); el.text = o?.text ?? ''; this.children.push(el); return el; }
  /** All text below this element, children joined by newlines. */
  allText(): string { return [this.text, ...this.children.map(c => c.allText())].filter(Boolean).join('\n'); }
  appendChild(el: El) { this.children.push(el); }
  empty() { this.children = []; this.text = ''; }
  addEventListener(name: string, cb: Handler) { this.listeners.set(name, cb); }
  focus() {}
  fire(name: string, ev: unknown) { this.listeners.get(name)?.(ev); }
}

export class ButtonComponent {
  text = ''; disabled = false; click: Handler = () => {};
  setButtonText(t: string) { this.text = t; return this; }
  setCta() { return this; }
  setIcon() { return this; }
  setTooltip() { return this; }
  setDisabled(d: boolean) { this.disabled = d; return this; }
  onClick(cb: Handler) { this.click = cb; return this; }
}
export class TextComponent {
  inputEl = new El(); value = ''; change: Handler = () => {};
  setPlaceholder() { return this; }
  setValue(v: string) { this.value = v; return this; }
  onChange(cb: Handler) { this.change = cb; return this; }
}

export const settings: Setting[] = [];
export class Setting {
  name = ''; desc = ''; buttons: ButtonComponent[] = []; texts: TextComponent[] = [];
  constructor(_el: unknown) { settings.push(this); }
  setName(n: string) { this.name = n; return this; }
  setDesc(d: string) { this.desc = d; return this; }
  setHeading() { return this; }
  addText(cb: (t: TextComponent) => void) { const t = new TextComponent(); this.texts.push(t); cb(t); return this; }
  addButton(cb: (b: ButtonComponent) => void) { const b = new ButtonComponent(); this.buttons.push(b); cb(b); return this; }
  addExtraButton(cb: (b: ButtonComponent) => void) { return this.addButton(cb); }
}

export class Modal {
  contentEl = new El();
  title = '';
  constructor(public app: App) {}
  setTitle(t: string) { this.title = t; return this; }
  open() { (this as any).onOpen?.(); }
  close() { (this as any).onClose?.(); }
}
export class FuzzySuggestModal<T> extends Modal {
  setPlaceholder() {}
  choose(item: T) { (this as any).onChooseItem(item); }
}

export class PluginSettingTab {
  containerEl = new El();
  constructor(public app: App, public plugin: unknown) {}
}

export class Plugin {
  data: unknown = null;
  commands = new Map<string, { name: string; callback: () => unknown }>();
  tabs: PluginSettingTab[] = [];
  statusEl = new El();
  constructor(public app: App, public manifest: unknown = {}) {}
  async loadData() { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)); }
  async saveData(d: unknown) { this.data = JSON.parse(JSON.stringify(d)); }
  addSettingTab(t: PluginSettingTab) { this.tabs.push(t); }
  addStatusBarItem() { return this.statusEl; }
  addCommand(c: { id: string; name: string; callback: () => unknown }) { this.commands.set(c.id, c); }
  registerEvent() {}
  registerInterval(id: number) { return id; }
}

export function normalizePath(p: string) { return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, ''); }
export async function requestUrl(): Promise<never> { throw new Error('requestUrl is not available in tests; set plugin.http'); }
