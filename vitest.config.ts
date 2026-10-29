import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { obsidian: fileURLToPath(new URL('./test/obsidian-mock.ts', import.meta.url)) } },
  test: { setupFiles: ['test/setup.ts'], include: ['test/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 120_000 },
});
