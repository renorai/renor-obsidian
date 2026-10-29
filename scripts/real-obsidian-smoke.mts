// Loads the built plugin (main.js) into a real Obsidian against the offline engine, drives it over the Chrome DevTools
// protocol and saves screenshots. Linux, under Xvfb:
//   curl -sSLo Obsidian.AppImage https://github.com/obsidianmd/obsidian-releases/releases/download/v1.12.7/Obsidian-1.12.7.AppImage
//   chmod +x Obsidian.AppImage && ./Obsidian.AppImage --appimage-extract
//   npm run build && xvfb-run -a -s "-screen 0 1280x800x24" node --experimental-strip-types \
//     scripts/real-obsidian-smoke.mts <squashfs-root/obsidian> <out dir> [path to playwright-core]
// Throws away its vault and engine when done. Not part of `npm test`: it needs the Obsidian binary.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startEngine } from '../test/engine.ts';
const require = createRequire(import.meta.url);
const [OBSIDIAN, S, PW = 'playwright-core'] = process.argv.slice(2);
const { chromium } = require(PW);
import { spawn } from 'node:child_process';
const PLUGIN = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const shots = path.join(S, 'shots'); fs.mkdirSync(shots, { recursive: true });
const engine = await startEngine();
const home = fs.mkdtempSync(path.join(S, 'home-'));
const vault = path.join(home, 'Demo Vault');
const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(vault, p)), { recursive: true }); fs.writeFileSync(path.join(vault, p), t); };
w('Projects/Heron launch.md', '# Heron launch\nThe Heron launch is on November 10. Owner: Ada.\n');
w('Projects/Private/Salary.md', '# Salary\nMy kestrel bonus.\n');
w('Journal/2026-10-21.md', 'Felt good about the plugin today.\n');
const pdir = path.join(vault, '.obsidian/plugins/renor'); fs.mkdirSync(pdir, { recursive: true });
for (const f of ['main.js', 'manifest.json']) fs.copyFileSync(path.join(PLUGIN, f), path.join(pdir, f));
fs.writeFileSync(path.join(pdir, 'data.json'), JSON.stringify({ settings: { serverUrl: engine.url, sharedFolders: [], privateFolders: [], renorFolder: 'Renor', pullMinutes: 15 } }));
fs.writeFileSync(path.join(vault, '.obsidian/community-plugins.json'), '["renor"]');
const cfg = path.join(home, '.config/obsidian'); fs.mkdirSync(cfg, { recursive: true });
fs.writeFileSync(path.join(cfg, 'obsidian.json'), JSON.stringify({ vaults: { a1b2c3d4e5f60718: { path: vault, ts: Date.now(), open: true } } }));
const proc = spawn(OBSIDIAN, ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=9333'], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') }, stdio: ['ignore', 'pipe', 'pipe'] });
let plog = ''; proc.stdout!.on('data', c => { plog += c; }); proc.stderr!.on('data', c => { plog += c; });
let browser: any;
for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9333'); } catch { await new Promise(r => setTimeout(r, 1000)); } }
if (!browser) { console.log(plog); throw new Error('no CDP'); }
let page: any;
for (let i = 0; i < 60 && !page; i++) { page = browser.contexts().flatMap((c: any) => c.pages()).find((p: any) => !p.url().startsWith('devtools')); if (!page) await new Promise(r => setTimeout(r, 1000)); }
const app = { close: async () => { await browser.close().catch(() => {}); proc.kill('SIGKILL'); } };
const log: string[] = [];
page.on('console', (m: any) => log.push(`${m.type()}: ${m.text()}`));
try {
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady, null, { timeout: 60_000 });
  const trust = page.getByText('Trust author and enable plugins');
  if (await trust.isVisible().catch(() => false)) await trust.click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(shots, '00-opened.png') });
  const state = await page.evaluate(async (token: string) => {
    const a = (window as any).app;
    await a.plugins.setEnable(true);
    await a.plugins.enablePluginAndSave('renor');
    const p = a.plugins.plugins.renor;
    const before = { loaded: !!p, version: a.plugins.manifests.renor?.version, status: document.querySelector('.status-bar')?.textContent };
    p.setApiKey(token); p.restart(); await p.sync.idle();
    await p.markPrivate('Projects/Private');
    await p.shareFolder('Projects');
    await p.sync.idle();
    return { before, shared: Object.keys(p.syncState.notes), dataHasKey: JSON.stringify(await p.loadData()).includes(token), appVersion: (window as any).electron ? 'electron' : '' };
  }, engine.token);
  console.log('STATE', JSON.stringify(state));
  const ctx = await fetch(engine.url, { method: 'POST', headers: { authorization: `Bearer ${engine.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_context', arguments: { query: 'Heron kestrel' } } }) });
  console.log('ENGINE', (await ctx.text()).slice(0, 400));
  // an edit typed in Obsidian goes through the vault's modify event
  await page.evaluate(async () => {
    const a = (window as any).app; const f = a.vault.getFileByPath('Projects/Heron launch.md');
    await a.vault.modify(f, '# Heron launch\nThe Heron launch moved to November 17. Owner: Ada.\n');
  });
  await page.waitForTimeout(3500);
  await page.evaluate(() => (window as any).app.plugins.plugins.renor.sync.idle());
  const ctx2 = await fetch(engine.url, { method: 'POST', headers: { authorization: `Bearer ${engine.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_context', arguments: { query: 'Heron November' } } }) });
  console.log('ENGINE-AFTER-EDIT', (await ctx2.text()).slice(0, 400));
  await fetch(engine.url, { method: 'POST', headers: { authorization: `Bearer ${engine.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'remember', arguments: { statement: 'Claude Code decided the Heron launch blog post ships the same day.' } } }) });
  await page.evaluate(() => (window as any).app.plugins.plugins.renor.pull(true));
  console.log('RENOR-FOLDER', JSON.stringify(fs.readdirSync(path.join(vault, 'Renor'))));
  await page.evaluate(() => { const a = (window as any).app; a.workspace.openLinkText('Projects/Heron launch.md', '', false); });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, '01-shared-status-bar.png') });
  await page.evaluate(() => { const a = (window as any).app; a.setting.open(); a.setting.openTabById('renor'); });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, '02-settings.png') });
  await page.evaluate(() => (window as any).app.setting.close());
  await page.evaluate(() => (window as any).app.commands.executeCommandById('renor:ask'));
  await page.waitForTimeout(400);
  await page.keyboard.type('When is the Heron launch?');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shots, '03-ask-renor.png') });
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const a = (window as any).app; const f = a.vault.getFiles().find((x: any) => x.path.startsWith('Renor/')); a.workspace.openLinkText(f.path, '', false); });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, '04-renor-folder-note.png') });
  const errors = log.filter(l => /error/i.test(l) && /renor/i.test(l));
  console.log('ERRORS', JSON.stringify(errors.slice(0, 10)));
  if (errors.length || !state.shared.length || state.dataHasKey) process.exitCode = 1;
} finally {
  await app.close();
  await engine.close();
}
