// No engine: the sharing rules, the MCP client's wire handling, the sync engine's ordering and debouncing, note names.
import { describe, expect, test } from 'vitest';
import { isShared, shareDecision, type SharingRules } from '../src/sharing';
import { RenorClient, RenorError, type HttpFn, type HttpRequest } from '../src/mcp';
import { SyncEngine, importLabel, type SyncBackend } from '../src/sync';
import { noteName, renderNote } from '../src/inbox';
import { clean, renderAnswer } from '../src/ask';

const rules = (over: Partial<SharingRules> = {}): SharingRules =>
  ({ sharedFolders: [], privateFolders: [], renorFolder: 'Renor', configDir: '.obsidian', ...over });

describe('sharing', () => {
  test('nothing is shared by default', () => {
    expect(isShared('Projects/a.md', rules())).toBe(false);
    expect(shareDecision('a.md', rules())).toEqual({ shared: false, reason: 'not in a shared folder' });
  });
  test('a chosen folder, its subfolders, and only that folder', () => {
    const r = rules({ sharedFolders: ['Projects'] });
    expect(isShared('Projects/a.md', r)).toBe(true);
    expect(isShared('Projects/deep/b.md', r)).toBe(true);
    expect(isShared('ProjectsOld/c.md', r)).toBe(false);
    expect(isShared('d.md', r)).toBe(false);
  });
  test('the whole vault, minus what is never shared', () => {
    const r = rules({ sharedFolders: ['/'], privateFolders: ['Journal', ' Health/ '] });
    expect(isShared('a.md', r)).toBe(true);
    expect(shareDecision('Journal/x.md', r)).toEqual({ shared: false, reason: 'private folder Journal' });
    expect(isShared('Health/y.md', r)).toBe(false);
    expect(isShared('Renor/2026-10-21 saved.md', r)).toBe(false);
    expect(isShared('.obsidian/workspace.md', r)).toBe(false);
    expect(isShared('.trash/z.md', r)).toBe(false);
    expect(isShared('image.png', r)).toBe(false);
    expect(isShared('canvas.canvas', r)).toBe(false);
  });
  test('a private folder wins over a shared folder inside it', () => {
    expect(isShared('Work/Private/Public/a.md', rules({ sharedFolders: ['Work/Private/Public'], privateFolders: ['Work/Private'] }))).toBe(false);
  });
});

type Reply = { status?: number; headers?: Record<string, string>; text?: string };
function fakeServer(reply: (req: HttpRequest, body: any) => Reply) {
  const seen: Array<{ req: HttpRequest; body: any }> = [];
  const http: HttpFn = async req => {
    const body = req.body ? JSON.parse(req.body) : undefined;
    seen.push({ req, body });
    const r = reply(req, body);
    return { status: r.status ?? 200, headers: r.headers ?? { 'content-type': 'application/json' }, text: r.text ?? '' };
  };
  return { http, seen };
}
const ok = (id: number, result: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result });

describe('MCP client', () => {
  test('initializes once, sends the bearer, keeps the session id, reads SSE replies', async () => {
    const { http, seen } = fakeServer((_req, body): Reply => {
      if (body.method === 'initialize') return { headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' }, text: ok(body.id, {}) };
      if (body.method === 'notifications/initialized') return { status: 202 };
      return { headers: { 'content-type': 'text/event-stream' }, text: `event: message\ndata: ${ok(body.id, { content: [{ type: 'text', text: '{"ok":true,"n":1}' }] })}\n\n` };
    });
    const client = new RenorClient('https://mcp.example/mcp', ' key-1 ', http);
    expect(await client.call('get_context', { query: 'x' })).toEqual({ ok: true, n: 1 });
    expect(await client.call('get_context', { query: 'y' })).toEqual({ ok: true, n: 1 });
    expect(seen.map(s => s.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
    expect(seen[0].req.headers.authorization).toBe('Bearer key-1');
    expect(seen[2].req.headers['mcp-session-id']).toBe('s1');
  });
  test('prefers structuredContent', async () => {
    const { http } = fakeServer((_r, b) => ({ text: ok(b.id, { structuredContent: { a: 1 }, content: [{ type: 'text', text: 'ignored' }] }) }));
    expect(await new RenorClient('https://mcp.example/mcp', 'k', http).call('x')).toEqual({ a: 1 });
  });
  test('a refused key says so; a tool error carries the tool\'s words', async () => {
    const refused = fakeServer(() => ({ status: 401, text: '{}' }));
    await expect(new RenorClient('https://mcp.example/mcp', 'k', refused.http).call('x')).rejects.toThrow(/refused the API key/);
    const failing = fakeServer((_r, b) => ({ text: b.method === 'tools/call' ? ok(b.id, { isError: true, content: [{ type: 'text', text: 'label needs a letter' }] }) : ok(b.id, {}) }));
    await expect(new RenorClient('https://mcp.example/mcp', 'k', failing.http).call('x')).rejects.toThrow('label needs a letter');
    expect(() => new RenorClient('https://mcp.example/mcp', '  ', failing.http)).toThrow(RenorError);
  });
  test('a forgotten session is started again once', async () => {
    let inits = 0, calls = 0;
    const { http } = fakeServer((req, b): Reply => {
      if (b.method === 'initialize') { inits++; return { headers: { 'content-type': 'application/json', 'mcp-session-id': `s${inits}` }, text: ok(b.id, {}) }; }
      if (b.method === 'notifications/initialized') return { status: 202 };
      calls++;
      if (req.headers['mcp-session-id'] === 's1') return { status: 404 };
      return { text: ok(b.id, { content: [{ type: 'text', text: '{"ok":true}' }] }) };
    });
    expect(await new RenorClient('https://mcp.example/mcp', 'k', http).call('x')).toEqual({ ok: true });
    expect([inits, calls]).toEqual([2, 2]);
  });
});

describe('sync engine', () => {
  function setup(debounceMs = 20) {
    const vault = new Map<string, string>([['A/one.md', '1'], ['A/two.md', '2'], ['B/three.md', '3']]);
    const calls: string[] = [];
    const tracked = new Set<string>();
    const backend: SyncBackend = {
      async upsert(path, text) {
        if (text === 'boom') throw new Error('network down');
        calls.push(`upsert ${path}=${text}`); tracked.add(path); return { status: 'synced' };
      },
      async remove(path) { calls.push(`remove ${path}`); tracked.delete(path); },
    };
    const r = rules({ sharedFolders: ['A'] });
    const engine = new SyncEngine({ listMarkdown: () => [...vault.keys()], read: async p => vault.get(p)! }, backend, () => r, () => [...tracked], debounceMs);
    return { vault, calls, r, engine };
  }
  test('reconcile sends shared notes only, then withdraws what left the share', async () => {
    const { calls, r, engine } = setup();
    expect(await engine.reconcile()).toMatchObject({ synced: 2 });
    expect(calls).toEqual(['upsert A/one.md=1', 'upsert A/two.md=2']);
    r.sharedFolders = ['B'];
    expect(await engine.reconcile()).toMatchObject({ synced: 1, removed: 2 });
    expect(calls.slice(2)).toEqual(['remove A/one.md', 'remove A/two.md', 'upsert B/three.md=3']);
  });
  test('typing is debounced into one upsert of the latest text', async () => {
    const { vault, calls, engine } = setup(30);
    for (const t of ['a', 'ab', 'abc']) { vault.set('A/one.md', t); engine.changed('A/one.md'); }
    await new Promise(r => setTimeout(r, 80));
    await engine.idle();
    expect(calls).toEqual(['upsert A/one.md=abc']);
  });
  test('a change outside the share is ignored; a failure is reported and the rest still sync', async () => {
    const { vault, calls, engine } = setup();
    engine.changed('B/three.md');
    vault.set('A/one.md', 'boom');
    const report = await engine.reconcile();
    expect(report.failed).toEqual([{ path: 'A/one.md', error: 'network down' }]);
    expect(calls).toEqual(['upsert A/two.md=2']);
  });
});

describe('names', () => {
  test('import label and Renor folder note names are safe file names', () => {
    expect(importLabel('My Vault!')).toBe('obsidian-My-Vault');
    expect(importLabel('***')).toBe('obsidian-vault');
    const m = { id: 'entry:x#1', kind: 'entry', path: 'Memory/Daily/2026-10-21.md', title: 'Use "SQLite"/no server: ok.', at: '2026-10-21T10:00:00Z', source: 'claude-code', tags: [] };
    expect(noteName(m)).toBe('2026-10-21 Use SQLite no server ok');
    expect(renderNote(m, 'Use SQLite.')).toContain('saved_by: "claude-code"');
  });
});

describe('Ask Renor rendering', () => {
  test('strips Markdown and daily-log stamps, links vault notes back', () => {
    expect(clean('# Heron launch\nThe launch moved.')).toBe('Heron launch — The launch moved.');
    expect(clean('- [22:58:05] (claude-code) Ship the post the same day.')).toBe('Ship the post the same day.');
    const out = renderAnswer('q', { memories: [
      { notePath: 'Imported/obsidian-V/Projects/Heron.md', text: '# Heron\nNov 17' },
      { notePath: 'Memory/Daily/2026-10-21.md', text: '- [10:00] (codex) Decided X' },
    ] }, 'obsidian-V');
    expect(out).toBe('- Heron — Nov 17 ([[Projects/Heron]])\n- Decided X (Renor: Memory/Daily/2026-10-21.md)');
  });
});
