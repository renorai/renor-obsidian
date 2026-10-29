// renor.json: the folder choices an agent can edit. Pure parsing and safety rules, then the plugin applying it both ways.
import { describe, expect, test } from 'vitest';
import { App, TFile, notices } from './obsidian-mock';
import RenorPlugin, { SECRET_ID } from '../src/main';
import { CONFIG_PATH, parseConfig, serializeConfig } from '../src/config';
import { isShared } from '../src/sharing';

const parse = (o: unknown) => parseConfig(typeof o === 'string' ? o : JSON.stringify(o), 'Renor', '.obsidian');

describe('parseConfig', () => {
  test('reads shared and private folders, normalised and deduplicated', () => {
    const { config, ignored } = parse({ sharedFolders: ['Work/', '/Notes', 'Work'], privateFolders: ['Work\\Private'] });
    expect(config).toEqual({ sharedFolders: ['Work', 'Notes'], privateFolders: ['Work/Private'] });
    expect(ignored).toEqual([]);
  });
  test('"/" shares the whole vault', () => {
    expect(parse({ sharedFolders: ['/'] }).config.sharedFolders).toEqual(['/']);
  });
  test('never shared whatever the file says: Renor/, .obsidian, dot-folders', () => {
    const { config, ignored } = parse({ sharedFolders: ['Renor', 'Renor/sub', '.obsidian', 'Work/.git', 'Work'] });
    expect(config.sharedFolders).toEqual(['Work']);
    expect(ignored).toHaveLength(4);
  });
  test('a private folder inside a shared folder still keeps its notes out', () => {
    const { config } = parse({ sharedFolders: ['Work'], privateFolders: ['Work/Private'] });
    const rules = { ...config, renorFolder: 'Renor', configDir: '.obsidian' };
    expect(isShared('Work/plan.md', rules)).toBe(true);
    expect(isShared('Work/Private/salary.md', rules)).toBe(false);
  });
  test('an API key or any unknown setting is ignored, with a reason that never repeats the value', () => {
    const { config, ignored } = parse({ sharedFolders: ['Work'], apiKey: 'sk-secret-123', theme: 'x' });
    expect(config.sharedFolders).toEqual(['Work']);
    expect(ignored.join(' ')).toContain('keys never go in this file');
    expect(ignored.join(' ')).not.toContain('sk-secret-123');
  });
  test('path traversal and non-strings are dropped; bad JSON throws', () => {
    expect(parse({ sharedFolders: ['../outside', 7, 'Work'] }).config.sharedFolders).toEqual(['Work']);
    expect(() => parse('{nope')).toThrow(/not valid JSON/);
    expect(() => parse('[]')).toThrow(/must be a JSON object/);
  });
});

describe('the plugin and renor.json', () => {
  const setup = async (files: Record<string, string> = {}, data: unknown = null) => {
    const app = new App();
    for (const [p, t] of Object.entries(files)) app.vault.files.set(p, t);
    const plugin = new RenorPlugin(app as any, {} as any);
    (plugin as any).data = data;
    await plugin.onload(); // no API key: nothing is sent, the folder settings still work
    await new Promise(r => setTimeout(r, 0));
    return { app, plugin };
  };
  const edit = async (app: App, text: string) => { await app.vault.modify(new TFile(CONFIG_PATH), text); await new Promise(r => setTimeout(r, 0)); };

  test('the file is created from the settings when missing, and has no key in it', async () => {
    const { app, plugin } = await setup({}, { settings: { sharedFolders: ['Work'], privateFolders: [] } });
    app.secretStorage.setSecret(SECRET_ID, 'sk-secret-123');
    await plugin.writeConfigFile();
    expect(JSON.parse(app.vault.files.get(CONFIG_PATH)!)).toEqual({ sharedFolders: ['Work'], privateFolders: [] });
    expect(app.vault.files.get(CONFIG_PATH)).not.toContain('sk-secret-123');
  });

  test('an agent edit is applied live, with a notice when the shared set changes', async () => {
    const { app, plugin } = await setup();
    notices.length = 0;
    await edit(app, JSON.stringify({ sharedFolders: ['Work', 'Notes'], privateFolders: ['Work/Private'] }));
    expect(plugin.settings.sharedFolders).toEqual(['Work', 'Notes']);
    expect(plugin.settings.privateFolders).toEqual(['Work/Private']);
    expect(notices.at(-1)).toBe('Renor: shared folders from renor.json: Work, Notes');
    expect((plugin as any).data.settings.sharedFolders).toEqual(['Work', 'Notes']); // saved, survives a restart
  });

  test('an edit that changes nothing shared gives no notice', async () => {
    const { app, plugin } = await setup({ [CONFIG_PATH]: JSON.stringify({ sharedFolders: ['Work'] }) });
    notices.length = 0;
    await edit(app, JSON.stringify({ sharedFolders: ['Work'], privateFolders: ['Work/Private'] }));
    expect(plugin.settings.privateFolders).toEqual(['Work/Private']);
    expect(notices).toEqual([]);
  });

  test('unsafe entries in the file never reach the settings', async () => {
    const { app, plugin } = await setup();
    await edit(app, JSON.stringify({ sharedFolders: ['Renor', '.obsidian', 'Work'], apiKey: 'sk-secret-123' }));
    expect(plugin.settings.sharedFolders).toEqual(['Work']);
    expect(JSON.stringify((plugin as any).data)).not.toContain('sk-secret-123');
    expect(notices.some(n => n.includes('is never shared'))).toBe(true);
  });

  test('invalid JSON keeps the settings and says so', async () => {
    const { app, plugin } = await setup({}, { settings: { sharedFolders: ['Work'] } });
    await edit(app, '{oops');
    expect(plugin.settings.sharedFolders).toEqual(['Work']);
    expect(notices.at(-1)).toMatch(/not valid JSON/);
  });

  test('settings changes are written to the file (two-way), without a write loop', async () => {
    const { app, plugin } = await setup();
    await plugin.shareFolder('Work');
    await plugin.markPrivate('Work/Private');
    expect(JSON.parse(app.vault.files.get(CONFIG_PATH)!)).toEqual({ sharedFolders: ['Work'], privateFolders: ['Work/Private'] });
    await plugin.removePrivate('Work/Private');
    await plugin.unshareFolder('Work');
    expect(JSON.parse(app.vault.files.get(CONFIG_PATH)!)).toEqual({ sharedFolders: [], privateFolders: [] });
    // an agent's own formatting is left alone when it already says what the settings say
    const mine = '{"sharedFolders":[],"privateFolders":[]}';
    await edit(app, mine);
    await plugin.writeConfigFile();
    expect(app.vault.files.get(CONFIG_PATH)).toBe(mine);
  });

  test('a folder the file drops from the private list stays private until removed in Settings', async () => {
    const { app, plugin } = await setup({ [CONFIG_PATH]: JSON.stringify({ sharedFolders: ['Work'], privateFolders: ['Work/Private'] }) });
    notices.length = 0;
    await edit(app, JSON.stringify({ sharedFolders: ['Work'], privateFolders: [] }));
    expect(plugin.settings.privateFolders).toEqual(['Work/Private']);
    expect(notices.some(n => n.includes('dropped Work/Private') && n.includes('stays private'))).toBe(true);
    expect(JSON.parse(app.vault.files.get(CONFIG_PATH)!).privateFolders).toEqual(['Work/Private']); // the file says what is true
    const rules = { ...plugin.settings, configDir: '.obsidian' };
    expect(isShared('Work/Private/salary.md', rules)).toBe(false);
    await plugin.removePrivate('Work/Private'); // the user's confirmation
    expect(plugin.settings.privateFolders).toEqual([]);
    expect(JSON.parse(app.vault.files.get(CONFIG_PATH)!).privateFolders).toEqual([]);
  });

  test('on startup the file wins over stored settings', async () => {
    const { plugin } = await setup({ [CONFIG_PATH]: serializeConfig({ sharedFolders: ['Agent'], privateFolders: [] }) }, { settings: { sharedFolders: ['Old'] } });
    expect(plugin.settings.sharedFolders).toEqual(['Agent']);
  });
});
