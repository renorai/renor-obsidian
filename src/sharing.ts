// Which notes leave the vault. Nothing is shared until the user picks a folder; a private folder, the Renor folder (what
// agents saved, mirrored in) and Obsidian's own config folder never are.

export interface SharingRules {
  /** Vault-relative folders the user chose to share. "/" shares the whole vault. Empty: nothing is shared. */
  sharedFolders: string[];
  /** Vault-relative folders that are never shared, even inside a shared folder. */
  privateFolders: string[];
  /** The folder the plugin writes agents' memories into. */
  renorFolder: string;
  /** Obsidian's config folder (vault.configDir, normally ".obsidian"). */
  configDir: string;
}

export function normalizeFolder(folder: string): string {
  const trimmed = folder.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  return trimmed;
}

function inside(path: string, folder: string): boolean {
  const f = normalizeFolder(folder);
  if (f === '') return true; // "/" or "": the whole vault
  return path === f || path.startsWith(f + '/');
}

export type ShareDecision = { shared: true } | { shared: false; reason: string };

export function shareDecision(path: string, rules: SharingRules): ShareDecision {
  if (!path.toLowerCase().endsWith('.md')) return { shared: false, reason: 'not a Markdown note' };
  if (path.split('/').some(part => part.startsWith('.'))) return { shared: false, reason: 'hidden file or folder' };
  if (inside(path, rules.configDir)) return { shared: false, reason: 'Obsidian settings' };
  if (normalizeFolder(rules.renorFolder) && inside(path, rules.renorFolder)) return { shared: false, reason: 'Renor folder (already in Renor)' };
  const priv = rules.privateFolders.filter(f => normalizeFolder(f)).find(f => inside(path, f));
  if (priv !== undefined) return { shared: false, reason: `private folder ${normalizeFolder(priv)}` };
  const chosen = rules.sharedFolders.map(f => f.trim()).filter(f => f.length > 0);
  if (!chosen.some(f => inside(path, f))) return { shared: false, reason: 'not in a shared folder' };
  return { shared: true };
}

export function isShared(path: string, rules: SharingRules): boolean {
  return shareDecision(path, rules).shared;
}
