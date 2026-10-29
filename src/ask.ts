// "Ask Renor": get_context for a question, rendered as Markdown for the modal and for inserting into a note.
import type { RenorClient } from './mcp';

export interface ContextHit { notePath?: string; headingPath?: string; text?: string; statement?: string; subject?: string; predicate?: string; object?: string; origin?: string }
export interface ContextReply { facts?: ContextHit[]; memories?: ContextHit[]; truncated?: boolean }

export async function askRenor(client: Pick<RenorClient, 'call'>, question: string, maxTokens = 1200): Promise<ContextReply> {
  return client.call<ContextReply>('get_context', { query: question, max_tokens: maxTokens });
}

/** Where a hit came from, as an Obsidian link when it is a note this vault shared. */
function sourceOf(hit: ContextHit, label: string): string {
  const prefix = `Imported/${label}/`;
  if (hit.notePath?.startsWith(prefix)) return `[[${hit.notePath.slice(prefix.length).replace(/\.md$/i, '')}]]`;
  return hit.notePath ? `Renor: ${hit.notePath}` : 'Renor';
}

/** One line of plain text: no leading heading marks, list bullet or daily-log "[hh:mm:ss] (source)" stamp. */
export function clean(text: string): string {
  return text.split(/\r?\n/)
    .map(l => l.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*[-*]\s+/, '').replace(/^\[\d{2}:\d{2}(:\d{2})?\]\s*(\([^)]*\)\s*)?/, '').trim())
    .filter(Boolean).join(' — ');
}

export function renderAnswer(question: string, reply: ContextReply, label: string): string {
  const facts = reply.facts ?? [];
  const memories = reply.memories ?? [];
  if (facts.length === 0 && memories.length === 0) return `Renor has nothing on "${question}" yet.`;
  const out: string[] = [];
  for (const f of facts) {
    const line = f.statement ?? [f.subject, f.predicate, f.object].filter(Boolean).join(' · ');
    if (line) out.push(`- ${line}`);
  }
  for (const m of memories) {
    const text = clean(m.text ?? '');
    if (text) out.push(`- ${text} (${sourceOf(m, label)})`);
  }
  return out.join('\n');
}
