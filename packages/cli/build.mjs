import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/webseal.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
await chmod('dist/webseal.js', 0o755);
