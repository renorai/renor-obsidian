import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

// Same rules Obsidian's directory review runs. Tests and build scripts are not plugin code.
export default defineConfig([
  globalIgnores(['node_modules', 'main.js', 'esbuild.config.mjs', 'scripts', 'test', 'vitest.config.ts', 'eslint.config.mjs']),
  ...obsidianmd.configs.recommended,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
]);
