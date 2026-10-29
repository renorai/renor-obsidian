// The Renor folder: what your agents saved to Renor, mirrored into the vault as notes you can read and link to. It is
// a one-way copy (Renor → vault). Notes that came from this vault (origin "import") are left out, so nothing echoes.
import type { RenorClient } from './mcp';

export interface MapMemory { id: string; kind: string; path: string; title: string; at: string; source: string | null; tags: string[]; origin?: string }

export interface NoteWriter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  ensureFolder(path: string): Promise<void>;
}

/** Inbox state kept in data.json: memory id → the vault note it was written to. */
export interface InboxState { written: Record<string, string> }

export function noteName(memory: MapMemory): string {
  const day = memory.at.slice(0, 10);
  const title = memory.title.replace(/[\\/:*?"<>|#^[\]\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[.\s]+$/, '') || 'Memory';
  return `${day} ${title}`;
}

export function renderNote(memory: MapMemory, text: string): string {
  const yaml = (v: string) => JSON.stringify(v);
  const lines = [
    '---',
    `renor_id: ${yaml(memory.id)}`,
    `saved: ${yaml(memory.at)}`,
    ...(memory.source ? [`saved_by: ${yaml(memory.source)}`] : []),
    ...(memory.tags.length ? [`tags: [${memory.tags.map(yaml).join(', ')}]`] : []),
    '---',
    '',
    text.trim(),
    '',
    '%% Copied from Renor. Edits here are not sent back; change it from an agent or the Renor dashboard. %%',
    '',
  ];
  return lines.join('\n');
}

export interface PullReport { written: number; updated: number; total: number }

/** The folder, if it is a plain vault-relative path: no leading "/", no "." or ".." segment, no backslash. */
function checkFolder(folder: string): string {
  const parts = folder.split('/');
  if (!folder || folder.includes('\\') || parts.some(p => p === '' || p === '.' || p === '..')) {
    throw new Error(`The Renor folder must be a folder inside the vault, like "Renor" (got "${folder}")`);
  }
  return folder;
}

/** True when `path` is a Markdown note directly inside `folder`, written the way this plugin names them. */
function insideFolder(path: string, folder: string): boolean {
  if (!path.startsWith(folder + '/') || !path.endsWith('.md')) return false;
  const name = path.slice(folder.length + 1);
  return name.length > 3 && !name.includes('/') && !name.includes('\\') && name !== '..md';
}

/** The renor_id in a note's front matter, or undefined when the note has none (so it is not one this plugin wrote). */
export function renorIdOf(text: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  const line = front && /^renor_id:\s*(.+?)\s*$/m.exec(front[1]);
  if (!line) return undefined;
  try { const v = JSON.parse(line[1]); return typeof v === 'string' ? v : undefined; } catch { return line[1]; }
}

/** Pulls the newest memories agents saved into `folder`. Existing notes are rewritten only when Renor's text changed. */
export async function pullInbox(
  client: Pick<RenorClient, 'call'>,
  writer: NoteWriter,
  folder: string,
  state: InboxState,
  limit = 100,
): Promise<PullReport> {
  const map = await client.call<{ memories?: MapMemory[] }>('memory_map', { limit });
  const memories = (map.memories ?? []).filter(m => m.origin !== 'import');
  const report: PullReport = { written: 0, updated: 0, total: memories.length };
  if (memories.length === 0) return report;
  checkFolder(folder);
  await writer.ensureFolder(folder);
  const taken = new Set(Object.values(state.written));
  for (const memory of memories) {
    const { text } = await client.call<{ text?: string }>('read_memory', { id: memory.id });
    const body = renderNote(memory, text ?? '');
    // data.json can be stale (the mirror was deleted and a note made in its place), synced from another device, or
    // edited: a remembered path is reused only inside the Renor folder, and an existing note there only when it is
    // this memory's own copy. Otherwise the memory gets a fresh name and the note found there is left alone.
    let target: string | undefined = state.written[memory.id];
    if (target !== undefined && (!insideFolder(target, folder)
      || (await writer.exists(target) && renorIdOf(await writer.read(target)) !== memory.id))) {
      target = undefined;
    }
    if (!target) {
      const base = `${folder}/${noteName(memory)}`;
      target = `${base}.md`;
      for (let n = 2; taken.has(target) || await writer.exists(target); n++) target = `${base} ${n}.md`;
      taken.add(target);
    }
    if (await writer.exists(target)) {
      if (await writer.read(target) === body) continue;
      report.updated++;
    } else {
      report.written++;
    }
    await writer.write(target, body);
    state.written[memory.id] = target;
  }
  return report;
}
