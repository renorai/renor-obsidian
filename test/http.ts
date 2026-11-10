import type { HttpFn } from '../src/mcp';

/** Node's fetch as an HttpFn: the tests' stand-in for Obsidian's requestUrl. */
export const fetchHttp: HttpFn = async req => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: res.status, headers, text: await res.text() };
};
