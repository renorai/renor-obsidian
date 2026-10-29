// The folder choices as a plain file an agent can read and edit: renor.json at the vault root. Pure; main.ts does the I/O.
// Only folder names live here. The API key stays in Obsidian's secret storage and is never read from or written to this file.
import { normalizeFolder } from './sharing';

export const CONFIG_PATH = 'renor.json';

export interface FolderConfig { sharedFolders: string[]; privateFolders: string[] }
export interface ParsedConfig { config: FolderConfig; ignored: string[] }

/** Folders that can never be shared whatever the file says (sharing.ts enforces the same at share time). */
function neverShared(folder: string, renorFolder: string, configDir: string): string | undefined {
  const f = normalizeFolder(folder);
  if (f.split('/').some(part => part.startsWith('.'))) return 'hidden folder';
  for (const [name, why] of [[configDir, 'Obsidian settings'], [renorFolder, 'Renor folder']] as const) {
    const n = normalizeFolder(name);
    if (n && (f === n || f.startsWith(n + '/'))) return why;
  }
  return undefined;
}

function list(value: unknown, field: string, ignored: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { ignored.push(`${field} must be a list of folder names`); return []; }
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') { ignored.push(`${field}: ${JSON.stringify(v)} is not a folder name`); continue; }
    const trimmed = v.trim();
    const folder = trimmed === '/' ? '/' : normalizeFolder(trimmed);
    if (folder === '' ) { ignored.push(`${field}: empty folder name`); continue; }
    if (folder.split('/').includes('..')) { ignored.push(`${field}: ${v} (.. is not allowed)`); continue; }
    if (!out.includes(folder)) out.push(folder);
  }
  return out;
}

/** Reads the file's text. Throws on text that is not a JSON object; unusable entries are returned in `ignored`. */
export function parseConfig(text: string, renorFolder: string, configDir: string): ParsedConfig {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error(`${CONFIG_PATH} is not valid JSON`); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${CONFIG_PATH} must be a JSON object`);
  const obj = raw as Record<string, unknown>;
  const ignored: string[] = [];
  for (const key of Object.keys(obj)) {
    if (key !== 'sharedFolders' && key !== 'privateFolders') {
      ignored.push(/key|token|secret|password/i.test(key) ? `${key}: keys never go in this file` : `${key}: unknown setting`);
    }
  }
  const privateFolders = list(obj.privateFolders, 'privateFolders', ignored).filter(f => f !== '/'); // the whole vault cannot be private here
  const sharedFolders = list(obj.sharedFolders, 'sharedFolders', ignored).filter(f => {
    const why = f === '/' ? undefined : neverShared(f, renorFolder, configDir);
    if (why) ignored.push(`sharedFolders: ${f} is never shared (${why})`);
    return !why;
  });
  return { config: { sharedFolders, privateFolders }, ignored };
}

export function serializeConfig(c: FolderConfig): string {
  return JSON.stringify({ sharedFolders: c.sharedFolders, privateFolders: c.privateFolders }, null, 2) + '\n';
}

export function sameFolders(a: FolderConfig, b: FolderConfig): boolean {
  const eq = (x: string[], y: string[]) => x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]);
  return eq(a.sharedFolders, b.sharedFolders) && eq(a.privateFolders, b.privateFolders);
}
