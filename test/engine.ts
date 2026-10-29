// Starts the self-hosted Renor HTTP server (engine/dist/mvp/cli.js) offline in a temporary folder, signs in as its one
// owner over OAuth and returns a bearer token: the backend the plugin's integration tests talk to. No model, no
// embeddings (MVP_EMBEDDING_PROVIDER=none), no network beyond 127.0.0.1.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ENGINE_DIR = path.resolve(here, '../../../engine');
export const ENGINE_CLI = path.join(ENGINE_DIR, 'dist/mvp/cli.js');
const OWNER_EMAIL = 'owner@example.test';
const REDIRECT = 'http://127.0.0.1:1/callback';

export interface Engine {
  url: string;
  token: string;
  memoryDir: string;
  close(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export function engineBuilt(): boolean {
  return fs.existsSync(ENGINE_CLI);
}

export async function startEngine(): Promise<Engine> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renor-obsidian-'));
  const memoryDir = path.join(root, 'memory');
  const authDir = path.join(root, 'auth');
  fs.mkdirSync(memoryDir, { mode: 0o700 });
  fs.mkdirSync(authDir, { mode: 0o700 });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const password = crypto.randomBytes(18).toString('base64url');
  const child: ChildProcess = spawn(process.execPath, [ENGINE_CLI], {
    cwd: ENGINE_DIR,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      MVP_MEMORY_DIR: memoryDir,
      MVP_PORT: String(port),
      MVP_BASE_URL: base,
      MVP_OWNER_EMAIL: OWNER_EMAIL,
      MVP_OWNER_PASSWORD: password,
      MVP_AUTH_STATE_PATH: path.join(authDir, 'clients.json'),
      MVP_ALLOWED_CALLBACK_URIS: REDIRECT,
      MVP_EMBEDDING_PROVIDER: 'none',
      RENOR_TELEMETRY_DISABLED: 'true',
      RENOR_SECRET_GUARD: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout!.on('data', c => { log += c; });
  child.stderr!.on('data', c => { log += c; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`engine did not start:\n${log}`)), 60_000);
    const poll = setInterval(() => {
      if (log.includes('MCP endpoint')) { clearInterval(poll); clearTimeout(timer); resolve(); }
    }, 50);
    child.once('exit', code => { clearInterval(poll); clearTimeout(timer); reject(new Error(`engine exited ${code}:\n${log}`)); });
  });
  const token = await signIn(base, password);
  return {
    url: `${base}/mcp`,
    token,
    memoryDir,
    async close() {
      if (child.exitCode === null) {
        const exited = new Promise(r => child.once('exit', r));
        child.kill('SIGTERM');
        await exited;
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The owner's consent flow, done programmatically: register a client, approve it as the owner, swap the code for a token. */
async function signIn(base: string, password: string): Promise<string> {
  const reg = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'obsidian-plugin-test', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'] }),
  });
  if (reg.status !== 201) throw new Error(`register: ${reg.status} ${await reg.text()}`);
  const { client_id, client_secret } = await reg.json() as { client_id: string; client_secret?: string };
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL('/authorize', base);
  authorize.search = new URLSearchParams({
    client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'memory',
  }).toString();
  const page = await (await fetch(authorize)).text();
  const ticket = page.match(/name="ticket" value="([^"]+)"/)?.[1];
  if (!ticket) throw new Error('no consent ticket on the authorize page');
  const login = await fetch(`${base}/mvp-login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket, approve: 'on', email: OWNER_EMAIL, password }).toString(),
  });
  const code = new URL(login.headers.get('location') ?? '', 'http://x').searchParams.get('code');
  if (!code) throw new Error(`owner login: ${login.status}`);
  const form: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id, code_verifier: verifier };
  if (client_secret) form.client_secret = client_secret;
  const tokens = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  if (tokens.status !== 200) throw new Error(`token: ${tokens.status} ${await tokens.text()}`);
  return (await tokens.json() as { access_token: string }).access_token;
}
