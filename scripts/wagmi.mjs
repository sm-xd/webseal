// Helper for the wagmi playground (apps/wagmi-playground): a real open-source dApp
// protected by WebSeal.
//
//   node scripts/wagmi.mjs build     build it and write its manifest (anchor name: WEBSEAL_ENS_NAME, default smxreds.eth)
//   node scripts/wagmi.mjs serve     serve it on http://localhost:4174 (PORT to change)
//   node scripts/wagmi.mjs tamper    the attack: Send Transaction keeps showing your address but sends to the attacker
//   node scripts/wagmi.mjs restore   undo the attack
//   node scripts/wagmi.mjs reproduce [URL]   rebuild it from the public repo and check URL serves exactly that
//
// The manifest names the public repo and the commit it was built from, so anyone can
// rebuild it (reproduce). Commit and push before building, or the commit will not match.
import { execFileSync, spawn } from 'node:child_process';
import { cp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const APP = join(ROOT, 'apps/wagmi-playground');
const DIST = join(APP, 'dist');
const CLEAN = join(APP, 'dist-clean');
const CLI = join(ROOT, 'packages/cli/dist/webseal.js');
// All lower case, so viem accepts it without an EIP-55 checksum check.
const ATTACKER = '0xbad0000000000000000000000000000000000bad';
// The minified Send Transaction handler reads the typed address with get("address").
const NEEDLE = 'get("address")';
const PATCH = `get("address")&&"${ATTACKER}"`;

const jsFiles = async () => (await readdir(join(DIST, 'assets'))).filter((n) => n.endsWith('.js')).map((n) => join(DIST, 'assets', n));
const isTampered = async () => (await Promise.all((await jsFiles()).map((f) => readFile(f, 'utf8')))).some((s) => s.includes(PATCH));

const REPO = process.env.WEBSEAL_REPO ?? 'https://github.com/sm-xd/webseal.git';
const BUILD = 'pnpm install --frozen-lockfile && pnpm --filter wagmi-playground run build';
const git = (...a) => execFileSync('git', a, { cwd: ROOT }).toString().trim();

const cmd = process.argv[2];
if (cmd === 'build') {
  execFileSync('pnpm', ['--filter', 'wagmi-playground', 'run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  // The manifest names the repo and commit, so the build can be reproduced from source.
  // WEBSEAL_NO_COMMIT=1 leaves them out (a fingerprint that does not change with every commit).
  const pinSource = !process.env.WEBSEAL_NO_COMMIT;
  if (pinSource && git('status', '--porcelain', '--', 'apps/wagmi-playground', 'pnpm-lock.yaml')) {
    console.log('warning   apps/wagmi-playground has uncommitted changes: this build will not match its commit (reproduce fails)');
  }
  execFileSync('node', [CLI, 'build', '--dist', DIST, '--name', process.env.WEBSEAL_ENS_NAME ?? 'smxreds.eth', ...(pinSource ? ['--repo', REPO] : ['--no-commit'])], { cwd: ROOT, stdio: 'inherit' });
} else if (cmd === 'reproduce') {
  const url = process.argv[3] ?? `http://localhost:${process.env.PORT ?? '4174'}`;
  const extra = process.env.WEBSEAL_REF ? ['--ref', process.env.WEBSEAL_REF] : [];
  try {
    execFileSync('node', [CLI, 'reproduce', url, '--build', BUILD, '--dist', 'apps/wagmi-playground/dist', ...extra, ...process.argv.slice(4)], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    process.exitCode = 1;
  }
} else if (cmd === 'serve') {
  const port = process.env.PORT ?? '4174';
  spawn('node', [join(ROOT, 'apps/demo/server.mjs')], { env: { ...process.env, PORT: port, WEBSEAL_DEMO_DIST: DIST }, stdio: 'inherit' });
} else if (cmd === 'tamper') {
  if (await isTampered()) {
    console.log('already tampered');
  } else {
    await rm(CLEAN, { recursive: true, force: true });
    await cp(DIST, CLEAN, { recursive: true });
    let hit = 0;
    for (const f of await jsFiles()) {
      const src = await readFile(f, 'utf8');
      if (!src.includes(NEEDLE)) continue;
      await writeFile(f, src.replace(NEEDLE, PATCH));
      console.log(`tampered  ${f.slice(DIST.length + 1).replace(/\\/g, '/')}`);
      console.log(`          Send Transaction now sends to ${ATTACKER}, whatever address you type`);
      hit++;
    }
    if (!hit) console.log('nothing to tamper: run "node scripts/wagmi.mjs build" first');
    else console.log('the page looks the same. Reload it.');
  }
} else if (cmd === 'restore') {
  if (!(await isTampered())) {
    console.log('build is clean, nothing to restore');
  } else if (!(await stat(CLEAN).catch(() => null))) {
    console.log('tampered but no backup: run "node scripts/wagmi.mjs build" again');
    process.exitCode = 1;
  } else {
    await rm(DIST, { recursive: true, force: true });
    await cp(CLEAN, DIST, { recursive: true });
    console.log('restored clean build');
  }
} else {
  console.log('usage: node scripts/wagmi.mjs build | serve | tamper | restore | reproduce [URL]');
  process.exitCode = 2;
}
