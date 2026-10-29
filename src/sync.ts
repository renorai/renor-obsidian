// Live sync of shared notes into Renor. The sync engine decides WHAT changed (vault events, a full reconcile on start
// or when the folder choice changes, content hashes so an unchanged save costs nothing); a SyncBackend decides HOW it
// reaches Renor. ImportToolsBackend uses Renor's existing import tools, so there is no second importer: each note is
// its own preview_import / apply_import batch under Imported/<label>/, and an edit or removal first undo_imports that
// note's previous batch (which retires the old copy, recoverable from Renor's trash) so recall never holds two versions.
import type { RenorClient } from './mcp';
import { isShared, type SharingRules } from './sharing';

export interface SyncBackend {
  /** Make Renor hold exactly this text for this vault path. */
  upsert(path: string, markdown: string, hash: string): Promise<UpsertResult>;
  /** Withdraw this vault path from Renor. */
  remove(path: string): Promise<void>;
}
export type UpsertResult = { status: 'synced' | 'unchanged' } | { status: 'skipped'; reason: string };

/** What the backend remembers per synced note; kept in the plugin's data.json. */
export interface SyncedNote { hash: string; batchId: string }
export interface SyncState { notes: Record<string, SyncedNote> }

/** The vault, as the sync engine sees it (Obsidian's Vault in the plugin, a Map in tests). */
export interface VaultReader {
  listMarkdown(): string[];
  read(path: string): Promise<string>;
}

export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** "My Vault!" → "obsidian-My-Vault": the folder Renor files these notes under (Imported/obsidian-<vault>/). */
export function importLabel(vaultName: string): string {
  const cleaned = vaultName.normalize('NFC').replace(/[^\p{L}\p{N}\p{M}_-]+/gu, '-').replace(/^-+|-+$/g, '');
  return `obsidian-${cleaned || 'vault'}`.slice(0, 64);
}

const FILE_LIMIT_BYTES = 64 * 1024;

/** Why Renor would not take this note, from a preview: a skipped file, or a note its secret guard held back. */
function skipReason(preview: any): string | undefined {
  const skipped = preview?.skipped?.[0];
  if (skipped) return String(skipped.reason ?? skipped.detail ?? 'skipped by Renor');
  if (preview?.secretGuard?.notes?.length) return 'Renor held it back: it looks like it contains a password, key or token';
  return undefined;
}

export class ImportToolsBackend implements SyncBackend {
  constructor(
    private readonly client: Pick<RenorClient, 'call'>,
    private readonly label: string,
    private readonly state: SyncState,
    private readonly save: () => Promise<void>,
  ) {}

  async upsert(path: string, markdown: string, hash: string): Promise<UpsertResult> {
    const known = this.state.notes[path];
    if (known?.hash === hash) return { status: 'unchanged' };
    if (new TextEncoder().encode(markdown).length > FILE_LIMIT_BYTES) {
      return { status: 'skipped', reason: 'over 64 KiB, the import limit per note: split it into smaller notes' };
    }
    // Check first, so a note Renor refuses (a secret in it, say) leaves the synced copy alone.
    const refused = skipReason(await this.preview(path, markdown, false));
    if (refused) return { status: 'skipped', reason: refused };
    if (known) await this.undo(path, known.batchId);
    const preview = await this.preview(path, markdown, true);
    const skipped = skipReason(preview);
    if (skipped) return { status: 'skipped', reason: skipped };
    if (preview.conflicts?.length) {
      // A different copy sits at the destination that this plugin did not record (data.json lost, or another device
      // synced it). It is kept, never overwritten; the note is reported rather than duplicated under another name.
      return { status: 'skipped', reason: `Renor already holds a different ${preview.conflicts[0]}; remove it there or rename this note` };
    }
    await this.client.call('apply_import', { batchId: preview.batchId });
    this.state.notes[path] = { hash, batchId: preview.batchId };
    await this.save();
    return { status: 'synced' };
  }

  async remove(path: string): Promise<void> {
    const known = this.state.notes[path];
    if (!known) return;
    await this.undo(path, known.batchId);
  }

  private async undo(path: string, batchId: string): Promise<void> {
    await this.client.call('undo_import', { batchId });
    delete this.state.notes[path];
    await this.save();
  }

  private preview(path: string, markdown: string, stage: boolean): Promise<any> {
    return this.client.call('preview_import', { label: this.label, files: [{ relativePath: path, markdown }], stage });
  }
}

export interface SyncReport { synced: number; unchanged: number; removed: number; skipped: Array<{ path: string; reason: string }>; failed: Array<{ path: string; error: string }> }
const emptyReport = (): SyncReport => ({ synced: 0, unchanged: 0, removed: 0, skipped: [], failed: [] });

/**
 * Turns vault events into backend calls, one note at a time and in order (a rename is a removal and an upsert).
 * Edits are debounced per note, so typing does not send every keystroke.
 */
export class SyncEngine {
  private chain: Promise<unknown> = Promise.resolve();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  last: SyncReport = emptyReport();

  constructor(
    private readonly vault: VaultReader,
    private readonly backend: SyncBackend,
    private readonly rules: () => SharingRules,
    private readonly tracked: () => string[],
    private readonly debounceMs = 2000,
  ) {}

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async upsertOne(path: string, report: SyncReport): Promise<void> {
    try {
      const text = await this.vault.read(path);
      const result = await this.backend.upsert(path, text, await sha256(text));
      if (result.status === 'skipped') report.skipped.push({ path, reason: result.reason });
      else if (result.status === 'synced') report.synced++;
      else report.unchanged++;
    } catch (err) {
      report.failed.push({ path, error: (err as Error).message });
    }
  }

  private async removeOne(path: string, report: SyncReport): Promise<void> {
    try { await this.backend.remove(path); report.removed++; }
    catch (err) { report.failed.push({ path, error: (err as Error).message }); }
  }

  /** Sync every shared note and withdraw every synced note that is no longer shared or no longer exists. */
  reconcile(): Promise<SyncReport> {
    return this.enqueue(async () => {
      const report = emptyReport();
      const rules = this.rules();
      const present = new Set(this.vault.listMarkdown());
      for (const path of this.tracked()) {
        if (!present.has(path) || !isShared(path, rules)) await this.removeOne(path, report);
      }
      for (const path of [...present].sort()) if (isShared(path, rules)) await this.upsertOne(path, report);
      this.last = report;
      return report;
    });
  }

  /** A note was created or modified. */
  changed(path: string): void {
    if (!isShared(path, this.rules()) && !this.tracked().includes(path)) return;
    clearTimeout(this.timers.get(path));
    this.timers.set(path, setTimeout(() => { this.timers.delete(path); void this.flush(path); }, this.debounceMs));
  }

  /** Sync one note now (also what a debounced change ends in). */
  flush(path: string): Promise<SyncReport> {
    return this.enqueue(async () => {
      const report = emptyReport();
      if (isShared(path, this.rules())) await this.upsertOne(path, report);
      else if (this.tracked().includes(path)) await this.removeOne(path, report);
      return report;
    });
  }

  deleted(path: string): Promise<SyncReport> {
    clearTimeout(this.timers.get(path));
    return this.enqueue(async () => {
      const report = emptyReport();
      if (this.tracked().includes(path)) await this.removeOne(path, report);
      return report;
    });
  }

  /** The old path's removal is queued before the new path's (debounced) sync, so Renor never holds both. */
  async renamed(path: string, oldPath: string): Promise<void> {
    const removal = this.deleted(oldPath);
    this.changed(path);
    await removal;
  }

  /** Wait for everything queued, including debounced edits (tests; plugin unload). */
  async idle(): Promise<void> {
    const pending = [...this.timers.keys()];
    for (const path of pending) { clearTimeout(this.timers.get(path)); this.timers.delete(path); void this.flush(path); }
    await this.chain;
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
