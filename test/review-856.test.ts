// Regressions for the two P1 findings of the PR #856 review: the key and notes must never go to a plain-HTTP (or
// otherwise unsupported) server, and a pull must never overwrite a note it does not own or write outside its folder.
import { describe, expect, test } from 'vitest';
import { App, settings } from './obsidian-mock'; // the same module src/ gets for 'obsidian' (vitest.config.ts)
import RenorPlugin, { RenorSettingTab } from '../src/main';
import { RenorClient, RenorError, checkServerUrl, type HttpFn } from '../src/mcp';
import { pullInbox, renderNote, type InboxState, type MapMemory, type NoteWriter } from '../src/inbox';

const spyHttp = () => {
  const urls: string[] = [];
  const http: HttpFn = async req => { urls.push(req.url); return { status: 500, headers: {}, text: '' }; };
  return { http, urls };
};

describe('finding 1: no key or note over plain HTTP', () => {
  const refused = [
    'http://attacker.example/mcp',
    'http://mcp.renor.cloud/mcp',
    'http://127.0.0.1.attacker.example/mcp',
    'http://localhost.attacker.example/mcp',
    'ftp://mcp.renor.cloud/mcp',
    'javascript:alert(1)',
    'mcp.renor.cloud/mcp',
    'https://user:pass@mcp.renor.cloud/mcp',
    '',
  ];
  test.each(refused)('%s is refused before any request', async url => {
    const { http, urls } = spyHttp();
    expect(() => new RenorClient(url, 'secret-key', http)).toThrow(RenorError);
    expect(urls).toEqual([]);
  });

  test.each([
    'https://mcp.renor.cloud/mcp',
    'https://renor.example.org:8443/mcp',
    'http://127.0.0.1:39471/mcp',
    'http://localhost:39471/mcp',
    'http://[::1]:39471/mcp',
  ])('%s is accepted (HTTPS, or HTTP on this machine only)', url => {
    expect(checkServerUrl(url)).toBe(url);
  });

  test('the plugin sends nothing when Server is set to an http:// address elsewhere', async () => {
    const app = new App();
    app.vault.files.set('Work/plan.md', '# Plan\nsecret plan\n');
    const plugin = new RenorPlugin(app as any, {} as any);
    const { http, urls } = spyHttp();
    plugin.http = http;
    await plugin.onload();
    plugin.setApiKey('secret-key');
    plugin.settings.serverUrl = 'http://attacker.example/mcp';
    plugin.settings.sharedFolders = ['Work'];
    plugin.restart();
    expect(plugin.client()).toBeUndefined();
    expect(plugin.sync).toBeUndefined();
    await plugin.reconcile(true);
    await plugin.pull(true);
    expect(urls).toEqual([]);
    expect((plugin as any).statusEl?.text ?? (plugin as any).status.text).toMatch(/https/i);
    plugin.onunload();
  });

  test('the settings field refuses such an address and keeps the previous one', async () => {
    const app = new App();
    const plugin = new RenorPlugin(app as any, {} as any);
    plugin.http = spyHttp().http;
    await plugin.onload();
    settings.length = 0;
    new RenorSettingTab(app as any, plugin).display();
    const server = settings.find(s => s.name === 'Server')!;
    await server.texts[0].change('http://attacker.example/mcp');
    expect(plugin.settings.serverUrl).toBe('https://mcp.renor.cloud/mcp');
    await server.texts[0].change('http://127.0.0.1:39471/mcp');
    expect(plugin.settings.serverUrl).toBe('http://127.0.0.1:39471/mcp');
    plugin.onunload();
  });
});

describe('finding 2: a pull only rewrites notes it owns, inside the Renor folder', () => {
  const memory: MapMemory = { id: 'entry:Memory/Daily/2026-10-21.md#m1', kind: 'entry', path: 'Memory/Daily/2026-10-21.md', title: 'Ship the draft first', at: '2026-10-21T10:00:00Z', source: 'claude-code', tags: [] };
  let text = 'Ship the draft first.';
  const client = { call: async (name: string) => (name === 'memory_map' ? { memories: [memory] } : { text }) } as any;
  const vault = () => {
    const files = new Map<string, string>();
    const writer: NoteWriter = {
      exists: async p => files.has(p), read: async p => files.get(p)!,
      write: async (p, t) => { files.set(p, t); }, ensureFolder: async () => {},
    };
    return { files, writer };
  };
  const first = 'Renor/2026-10-21 Ship the draft first.md';

  test('a personal note created where a deleted mirror used to be is kept', async () => {
    const { files, writer } = vault();
    const state: InboxState = { written: {} };
    await pullInbox(client, writer, 'Renor', state);
    expect(state.written[memory.id]).toBe(first);
    files.delete(first);
    files.set(first, 'My own note. Do not touch.');
    text = 'Ship the draft first, then list it.';
    await pullInbox(client, writer, 'Renor', state);
    expect(files.get(first)).toBe('My own note. Do not touch.');
    expect(state.written[memory.id]).toBe('Renor/2026-10-21 Ship the draft first 2.md');
    expect(files.get(state.written[memory.id])).toContain('then list it.');
  });

  test('a note synced from another device under that name, for another memory, is kept', async () => {
    const { files, writer } = vault();
    const other = renderNote({ ...memory, id: 'entry:other#m2' }, 'Another memory.');
    files.set(first, other);
    const state: InboxState = { written: { [memory.id]: first } };
    await pullInbox(client, writer, 'Renor', state);
    expect(files.get(first)).toBe(other);
    expect(state.written[memory.id]).not.toBe(first);
  });

  test.each(['Journal/today.md', '../outside.md', 'Renor/../Journal/today.md', '/Renor/x.md', 'Renor/sub/../../x.md', 'Renor/x.txt'])(
    'state pointing at %s is not written to', async bad => {
      const { files, writer } = vault();
      files.set(bad, 'Personal.');
      const state: InboxState = { written: { [memory.id]: bad } };
      await pullInbox(client, writer, 'Renor', state);
      expect(files.get(bad)).toBe('Personal.');
      expect(state.written[memory.id]).toMatch(/^Renor\/2026-10-21 Ship the draft first( \d+)?\.md$/);
      expect([...files.keys()].filter(p => p !== bad).every(p => p.startsWith('Renor/') && !p.includes('..'))).toBe(true);
    });

  test('a note it owns is still updated in place', async () => {
    const { files, writer } = vault();
    const state: InboxState = { written: {} };
    text = 'v1';
    await pullInbox(client, writer, 'Renor', state);
    text = 'v2';
    expect(await pullInbox(client, writer, 'Renor', state)).toMatchObject({ updated: 1, written: 0 });
    expect(state.written[memory.id]).toBe(first);
    expect(files.get(first)).toContain('v2');
  });

  test('a Renor folder setting that leaves the vault folder is refused', async () => {
    const { files, writer } = vault();
    await expect(pullInbox(client, writer, '../elsewhere', { written: {} })).rejects.toThrow(/folder/);
    expect(files.size).toBe(0);
  });
});
