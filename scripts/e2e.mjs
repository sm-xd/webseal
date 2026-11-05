// CLI-only end-to-end: build manifest, serve, verify, tamper, verify fails, restore.
import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEMO = join(ROOT, 'apps/demo');
const CLI = join(ROOT, 'packages/cli/dist/webseal.js');
const PORT = 4198;
const run = (args, ok = true) => {
  try {
    return { code: 0, out: execFileSync('node', args, { cwd: ROOT, stdio: 'pipe' }).toString() };
  } catch (e) {
    if (ok) throw e;
    return { code: e.status, out: e.stdout.toString() };
  }
};
let failures = 0;
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

run([join(DEMO, 'restore.mjs')]);
run([CLI, 'build', '--dist', join(DEMO, 'dist'), '--name', 'acme-demo.eth']);
const hash = createHash('sha256').update(await readFile(join(DEMO, 'dist/.well-known/webseal.json'))).digest('hex');
const server = spawn('node', [join(DEMO, 'server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
try {
  const clean = run([CLI, 'verify', `http://localhost:${PORT}`, '--expect', hash], false);
  check(clean.code === 0 && /VERIFIED/.test(clean.out), 'clean build verifies');
  run([join(DEMO, 'tamper.mjs')]);
  const bad = run([CLI, 'verify', `http://localhost:${PORT}`, '--expect', hash], false);
  check(bad.code === 1 && /MISMATCH \/assets\/index-/.test(bad.out), 'tampered build fails and names the file');
  const wrongAnchor = run([CLI, 'verify', `http://localhost:${PORT}`, '--expect', 'a'.repeat(64)], false);
  check(wrongAnchor.code === 1 && /manifest  MISMATCH/.test(wrongAnchor.out), 'wrong anchor fails on the manifest');
  run([join(DEMO, 'restore.mjs')]);
  const again = run([CLI, 'verify', `http://localhost:${PORT}`, '--expect', hash], false);
  check(again.code === 0, 'restored build verifies');
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
