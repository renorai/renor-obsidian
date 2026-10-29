import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineCli = path.resolve(pluginDir, '../../engine/dist/mvp/cli.js');

if (!existsSync(engineCli)) {
  console.warn('SKIPPED engine-backed suites (test/engine.test.ts, test/plugin.test.ts): engine/dist/mvp/cli.js is unavailable; run npm run test:standalone for the engine-independent suites.');
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('run this test command through npm');
const result = spawnSync(process.execPath, [npmCli, 'exec', '--', 'vitest', 'run'], { cwd: pluginDir, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
