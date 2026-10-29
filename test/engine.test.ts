// Against the real self-hosted engine, offline: sync, edit, unshare, delete, secrets, the Renor folder, Ask Renor.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { engineBuilt, startEngine, type Engine } from './engine';
import { RenorClient, fetchHttp } from '../src/mcp';
import { ImportToolsBackend, SyncEngine, importLabel, type SyncState } from '../src/sync';
import type { SharingRules } from '../src/sharing';
import { pullInbox, type InboxState, type NoteWriter } from '../src/inbox';
import { askRenor, renderAnswer } from '../src/ask';

const run = engineBuilt() ? describe : describe.skip;

run('against the offline engine', () => {
  let engine: Engine;
  let client: RenorClient;
  const vault = new Map<string, string>();
  const state: SyncState = { notes: {} };
  const rules: SharingRules = { sharedFolders: [], privateFolders: ['Projects/Private'], renorFolder: 'Renor', configDir: '.obsidian' };
  const label = importLabel('Test Vault');
  let sync: SyncEngine;

  const ask = async (q: string) => JSON.stringify((await askRenor(client, q)).memories ?? []);

  beforeAll(async () => {
    engine = await startEngine();
    client = new RenorClient(engine.url, engine.token, fetchHttp);
    vault.set('Projects/fjord.md', '# Fjord\nFjord stores everything in SQLite.\n');
    vault.set('Projects/Private/diary.md', '# Diary\nThe zanzibar plan is secret.\n');
    vault.set('Inbox/random.md', '# Random\nQuokka sightings near the harbour.\n');
    vault.set('Renor/2026-10-21 old.md', 'mirrored copy, never sent back\n');
    const backend = new ImportToolsBackend(client, label, state, async () => {});
    sync = new SyncEngine(
      { listMarkdown: () => [...vault.keys()], read: async p => vault.get(p)! },
      backend, () => rules, () => Object.keys(state.notes), 10,
    );
  });
  afterAll(async () => { await engine?.close(); });

  test('nothing is shared until a folder is chosen', async () => {
    const report = await sync.reconcile();
    expect(report.synced).toBe(0);
    expect(await ask('Fjord SQLite')).toBe('[]');
  });

  test('a chosen folder syncs, its private subfolder and the Renor folder do not', async () => {
    rules.sharedFolders = ['Projects'];
    const report = await sync.reconcile();
    expect(report).toMatchObject({ synced: 1, failed: [] });
    expect(Object.keys(state.notes)).toEqual(['Projects/fjord.md']);
    expect(await ask('Fjord SQLite')).toContain(`Imported/${label}/Projects/fjord.md`);
    expect(await ask('zanzibar')).toBe('[]');
    expect(await ask('Quokka')).toBe('[]');
    expect((await sync.reconcile()).unchanged).toBe(1); // same text again: no call that writes
  });

  test('an edit replaces the old copy instead of adding a second one', async () => {
    vault.set('Projects/fjord.md', '# Fjord\nFjord moved to Postgres in October.\n');
    sync.changed('Projects/fjord.md');
    await sync.idle();
    const hits = (await askRenor(client, 'Fjord')).memories ?? [];
    expect(hits.map(h => h.text)).toEqual(['# Fjord\nFjord moved to Postgres in October.']);
    expect(await ask('SQLite')).toBe('[]');
  });

  test('a note with a secret in it is held back and its synced copy kept', async () => {
    const before = state.notes['Projects/fjord.md'];
    vault.set('Projects/fjord.md', '# Fjord\nPostgres password: AKIAIOSFODNN7EXAMPLE secret key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n');
    const report = await sync.flush('Projects/fjord.md');
    expect(report.synced).toBe(0);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual([{ path: 'Projects/fjord.md', reason: expect.stringMatching(/secret|password|key|token/i) }]);
    expect(state.notes['Projects/fjord.md']).toEqual(before);
    expect(await ask('Postgres October')).toContain('Postgres in October');
    vault.set('Projects/fjord.md', '# Fjord\nFjord moved to Postgres in October.\n');
  });

  test('unsharing a folder and deleting a note withdraw them', async () => {
    vault.set('Projects/beta.md', '# Beta\nBeta launches with the narwhal release.\n');
    sync.changed('Projects/beta.md');
    await sync.idle();
    expect(await ask('narwhal')).toContain('beta.md');
    vault.delete('Projects/beta.md');
    await sync.deleted('Projects/beta.md');
    expect(await ask('narwhal')).toBe('[]');
    rules.sharedFolders = [];
    const report = await sync.reconcile();
    expect(report.removed).toBe(1);
    expect(state.notes).toEqual({});
    expect(await ask('Postgres October')).toBe('[]');
  });

  test('a rename moves the note', async () => {
    rules.sharedFolders = ['Projects'];
    await sync.reconcile();
    vault.set('Projects/fjord-db.md', vault.get('Projects/fjord.md')!);
    vault.delete('Projects/fjord.md');
    await sync.renamed('Projects/fjord-db.md', 'Projects/fjord.md');
    await sync.idle();
    expect(Object.keys(state.notes)).toEqual(['Projects/fjord-db.md']);
    const hits = (await askRenor(client, 'Fjord Postgres')).memories ?? [];
    expect(hits.map(h => h.notePath)).toEqual([`Imported/${label}/Projects/fjord-db.md`]);
  });

  test('what agents saved appears in the Renor folder, vault imports do not', async () => {
    await client.call('remember', { statement: 'The team decided to ship the Obsidian plugin as a draft first.' });
    const files = new Map<string, string>();
    const writer: NoteWriter = {
      exists: async p => files.has(p), read: async p => files.get(p)!,
      write: async (p, t) => { files.set(p, t); }, ensureFolder: async () => {},
    };
    const inbox: InboxState = { written: {} };
    const first = await pullInbox(client, writer, 'Renor', inbox);
    expect(first.written).toBe(1);
    const [[path, text]] = [...files];
    expect(path).toMatch(/^Renor\/\d{4}-\d{2}-\d{2} The team decided to ship the Obsidian plugin as a draft first\.md$/);
    expect(text).toContain('renor_id: "entry:');
    expect(text).toContain('The team decided to ship the Obsidian plugin as a draft first.');
    expect((await pullInbox(client, writer, 'Renor', inbox)).written).toBe(0); // idempotent
  });

  test('Ask Renor links back to the vault note it came from', async () => {
    const reply = await askRenor(client, 'Fjord Postgres');
    expect(renderAnswer('Fjord Postgres', reply, label)).toContain('[[Projects/fjord-db]]');
    expect(renderAnswer('zzz', {}, label)).toBe('Renor has nothing on "zzz" yet.');
  });
});
