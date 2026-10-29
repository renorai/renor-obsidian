// A minimal MCP client over HTTP for Renor's hosted endpoint (https://mcp.renor.cloud/mcp) and the self-hosted HTTP
// server. Only what the plugin needs: initialize once, then tools/call. The HTTP call itself is injected, so the plugin
// passes Obsidian's requestUrl (no CORS in the app) and the tests pass Node's fetch.

export interface HttpRequest {
  url: string;
  method: 'POST' | 'DELETE';
  headers: Record<string, string>;
  body?: string;
}
export interface HttpResponse {
  status: number;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  text: string;
}
export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export const HOSTED_URL = 'https://mcp.renor.cloud/mcp';
const PROTOCOL_VERSION = '2025-03-26';

export class RenorError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'RenorError'; }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The server address, if the API key and notes may be sent to it: HTTPS anywhere, or plain HTTP only to this machine
 * (a self-hosted Renor on 127.0.0.1 / localhost / ::1, which never leaves the computer). Anything else, a URL with a
 * user name or password in it included, is refused before a single request is made.
 */
export function checkServerUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new RenorError(`Server must be an https:// address (got "${raw.trim()}")`); }
  if (url.username || url.password) throw new RenorError('Server must not contain a user name or password');
  if (url.protocol === 'https:') return raw.trim();
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return raw.trim();
  throw new RenorError('Server must be an https:// address (plain http:// only to 127.0.0.1 or localhost), so your key and notes are never sent unencrypted');
}

/** One JSON-RPC message out of a reply that is either plain JSON or a text/event-stream. */
function parseReply(res: HttpResponse, id: number): any {
  const type = res.headers['content-type'] ?? '';
  const candidates: string[] = [];
  if (type.includes('text/event-stream')) {
    for (const event of res.text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (data) candidates.push(data);
    }
  } else {
    candidates.push(res.text);
  }
  for (const raw of candidates) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { continue; }
    for (const m of Array.isArray(msg) ? msg : [msg]) if (m && m.id === id) return m;
  }
  throw new RenorError(`Renor sent a reply the plugin could not read (HTTP ${res.status})`, res.status);
}

export class RenorClient {
  private nextId = 1;
  private session: string | undefined;
  private ready: Promise<void> | undefined;

  private readonly url: string;

  constructor(url: string, private readonly token: string, private readonly http: HttpFn) {
    this.url = checkServerUrl(url);
    if (!token.trim()) throw new RenorError('No API key: paste one from the Renor dashboard in the plugin settings');
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token.trim()}`,
      'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (this.session) h['mcp-session-id'] = this.session;
    return h;
  }

  private async rpc(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const res = await this.http({ url: this.url, method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (res.status === 401 || res.status === 403) throw new RenorError('Renor refused the API key: check it in the plugin settings', res.status);
    if (res.status === 404 && this.session) { this.session = undefined; this.ready = undefined; throw new RenorError('session expired', 404); }
    if (res.status >= 400) throw new RenorError(`Renor answered HTTP ${res.status}`, res.status);
    if (res.headers['mcp-session-id']) this.session = res.headers['mcp-session-id'];
    const msg = parseReply(res, id);
    if (msg.error) throw new RenorError(`${method}: ${msg.error.message ?? 'error'}`);
    return msg.result;
  }

  private initialize(): Promise<void> {
    this.ready ??= (async () => {
      await this.rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'renor-obsidian', version: '0.1.0' } });
      await this.http({ url: this.url, method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    })().catch(err => { this.ready = undefined; throw err; });
    return this.ready;
  }

  /** Calls one tool and returns its JSON body. A tool error (isError) becomes a RenorError carrying the tool's own words. */
  async call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.initialize();
      try {
        const result = await this.rpc('tools/call', { name, arguments: args });
        const text = (result?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n');
        if (result?.isError) throw new RenorError(text || `${name} failed`);
        if (result?.structuredContent) return result.structuredContent as T;
        try { return JSON.parse(text) as T; } catch { return { text } as T; }
      } catch (err) {
        // A session the server has forgotten: start one more, once.
        if (attempt === 0 && err instanceof RenorError && err.status === 404) continue;
        throw err;
      }
    }
  }
}

/** Node / browser fetch as an HttpFn (tests, and anywhere outside Obsidian). */
export const fetchHttp: HttpFn = async req => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: res.status, headers, text: await res.text() };
};
