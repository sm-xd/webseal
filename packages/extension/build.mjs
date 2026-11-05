import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const common = { bundle: true, target: 'chrome120', logLevel: 'info', sourcemap: false, minify: false };

await build({ ...common, entryPoints: ['src/background.ts'], outfile: 'dist/background.js', format: 'esm' });
await build({ ...common, entryPoints: ['src/content.ts'], outfile: 'dist/content.js', format: 'iife' });
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js', format: 'iife' });
await build({ ...common, entryPoints: ['src/popup.ts'], outfile: 'dist/popup.js', format: 'iife' });
for (const f of ['manifest.json', 'src/popup.html', 'src/popup.css']) {
  await copyFile(f, 'dist/' + f.replace(/^src\//, ''));
}
