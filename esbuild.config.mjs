// Bundles src/main.ts into main.js, the file Obsidian loads. `obsidian` and Electron are provided by the app.
import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  external: ['obsidian', 'electron', '@codemirror/*'],
  outfile: 'main.js',
  logLevel: 'info',
});
