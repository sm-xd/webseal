// Undo tamper.mjs. Only acts when the served build is actually tampered, so it
// never overwrites a fresh build with an old backup.
import { cp, rm, stat, readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, 'dist');
const CLEAN = join(here, 'dist-clean');
const ATTACKER = process.env.ATTACKER ?? '0xBAD0000000000000000000000000000000000bad';

const assets = join(DIST, 'assets');
const names = (await readdir(assets).catch(() => [])).filter((n) => n.endsWith('.js'));
const tampered = (await Promise.all(names.map((n) => readFile(join(assets, n), 'utf8')))).some((s) => s.includes(ATTACKER));

if (!tampered) {
  console.log('build is clean, nothing to restore');
  await rm(CLEAN, { recursive: true, force: true }); // drop any stale backup
} else if (!(await stat(CLEAN).catch(() => null))) {
  console.log('build is tampered but no backup exists: rebuild the demo (pnpm build)');
  process.exitCode = 1;
} else {
  await rm(DIST, { recursive: true, force: true });
  await cp(CLEAN, DIST, { recursive: true });
  console.log('restored clean build');
}
