import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import {
  MANIFEST_PATH,
  extractInlineScripts,
  formatRecord,
  manifestBytes,
  manifestHash,
  parseManifest,
  parseRecord,
  sha256Hex,
  summarize,
  verifyFiles,
  type FileResult,
  type Manifest,
} from '@webseal/core';
import type { Address, Hex } from 'viem';
import {
  describeFee,
  grantRecordWriter,
  linkNames,
  readRecord,
  readRecordWithFallback,
  recordWriters,
  revokeRecordWriter,
  writeRecord,
  type Signer,
  type TxResult,
} from './ens.ts';

const USAGE = `webseal: anchor a web frontend's build hash on ENS and verify what a server serves.

  webseal build   [--dist dist] [--name app.eth] [--repo GIT_URL] [--out dist/.well-known/webseal.json] [--no-commit]
  webseal publish --name app.eth [--manifest path | --hash HEX] [--keep-current | --also HEX] [--dry-run]
  webseal record  --name app.eth
  webseal verify  URL [--name app.eth | --expect HEX] [--json]
  webseal reproduce URL [--repo GIT_URL] [--ref COMMIT] [--build "cmd"] [--dist dir] [--name app.eth]
                  rebuild the site from its public source and check it serves exactly that

  ENSv2 (Permissioned Resolver):
  webseal grant   --name app.eth --to 0xCI_KEY     let that key change only the webseal record
  webseal revoke  --name app.eth --from 0xCI_KEY   take it back
  webseal writers --name app.eth [--check 0xADDR]  who can change the record
  webseal link    --name beta.app.eth --to app.eth serve one record from both names

  Every command takes [--chain sepolia|mainnet] (default sepolia) and [--rpc URL].
  Writes are signed with --key 0x... or env WEBSEAL_PRIVATE_KEY; pass --as 0xADDRESS
  instead to simulate the transaction as that account and see its cost, with no key.
`;

const NETWORK_OPTIONS = {
  chain: { type: 'string', default: 'sepolia' },
  rpc: { type: 'string' },
} as const;
const SIGNER_OPTIONS = {
  key: { type: 'string' },
  as: { type: 'string' },
} as const;

function signerFrom(values: { key?: string; as?: string }): Signer {
  if (values.as) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(values.as)) throw new Error('--as must be an address');
    return { as: values.as as Address };
  }
  let key = (values.key ?? process.env.WEBSEAL_PRIVATE_KEY)?.trim() as Hex | undefined;
  if (!key) throw new Error('private key missing: pass --key, set WEBSEAL_PRIVATE_KEY, or simulate with --as 0xADDRESS');
  // Wallets such as MetaMask show the key without the 0x prefix.
  if (/^[0-9a-fA-F]{64}$/.test(key)) key = `0x${key}` as Hex;
  if (/^0x[0-9a-fA-F]{40}$/.test(key)) {
    throw new Error('WEBSEAL_PRIVATE_KEY holds an address (0x + 40 hex), not a private key (0x + 64 hex). Export the private key from the wallet (MetaMask: account details, show private key), or use --as <address> for a dry run.');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('the private key must be 0x followed by 64 hex characters');
  return { privateKey: key };
}

function address(v: string | undefined, flag: string): Address {
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${flag} must be an address (0x + 40 hex)`);
  return v as Address;
}

function printTx(r: TxResult) {
  console.log(`from      ${r.from}`);
  console.log(`resolver  ${r.resolver}`);
  if (r.simulated) console.log(`dry run   would succeed; cost about ${describeFee(r)}`);
  else console.log(`tx        ${r.tx} (${r.status}); paid ${describeFee(r)}`);
  if (!r.simulated && r.status !== 'success') throw new Error(`transaction ${r.tx} did not succeed (${r.status})`);
}

async function walk(dir: string, root = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, root)));
    else if (entry.isFile()) out.push('/' + relative(root, full).split(sep).join('/'));
  }
  return out.sort();
}

function gitCommit(): string | undefined {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return undefined;
  }
}

/** The manifest of a build directory. `skip` is the manifest's own path, which it never lists. */
async function manifestOf(dist: string, meta: { name?: string; commit?: string; repo?: string }, skip = MANIFEST_PATH): Promise<Manifest> {
  const files: Record<string, string> = {};
  const inline = new Set<string>();
  for (const path of await walk(dist)) {
    if (path === skip) continue;
    const bytes = await readFile(join(dist, path));
    files[path] = await sha256Hex(bytes);
    if (/\.html?$/i.test(path)) {
      for (const body of extractInlineScripts(bytes.toString('utf8'))) inline.add(await sha256Hex(body));
    }
  }
  const manifest: Manifest = { version: 1, files };
  if (meta.name) manifest.name = meta.name;
  if (meta.commit) manifest.commit = meta.commit;
  if (meta.repo) manifest.repo = meta.repo;
  if (inline.size) manifest.inline = Array.from(inline).sort();
  return manifest;
}

async function cmdBuild(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      dist: { type: 'string', default: 'dist' },
      name: { type: 'string' },
      out: { type: 'string' },
      commit: { type: 'boolean', default: true },
      repo: { type: 'string' },
    },
    allowNegative: true,
  });
  const dist = resolve(values.dist!);
  if (!(await stat(dist).catch(() => null))?.isDirectory()) throw new Error(`no such directory: ${dist}`);
  const out = resolve(values.out ?? join(dist, '.well-known', 'webseal.json'));
  const outRel = '/' + relative(dist, out).split(sep).join('/');

  const manifest = await manifestOf(dist, { name: values.name, commit: values.commit ? gitCommit() : undefined, repo: values.repo }, outRel);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, manifestBytes(manifest));
  const hash = await manifestHash(manifest);
  const inline = manifest.inline?.length ?? 0;
  console.log(`manifest  ${out}`);
  console.log(`files     ${Object.keys(manifest.files).length}` + (inline ? `  inline scripts ${inline}` : ''));
  console.log(`hash      ${hash}`);
  console.log(`record    ${formatRecord(hash)}`);
  if (inline) console.log(`note      inline scripts were found; hashing them is a weaker guarantee than external files`);
}

/**
 * Proves a live site serves exactly what its public source builds to: clone the repo at the
 * commit, run the build, hash the output the same way `build` does, and compare it with the
 * manifest the site serves. Needs no trust in the publisher's CI or servers.
 */
async function cmdReproduce(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      ref: { type: 'string' },
      dist: { type: 'string', default: 'dist' },
      build: { type: 'string', default: 'pnpm install --frozen-lockfile && pnpm build' },
      keep: { type: 'boolean', default: false },
      ...NETWORK_OPTIONS,
      name: { type: 'string' },
    },
  });
  const base = positionals[0];
  if (!base) throw new Error('URL is required');
  const manifestUrl = new URL(MANIFEST_PATH, new URL(base));
  const res = await fetch(manifestUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`manifest not served at ${manifestUrl} (HTTP ${res.status})`);
  const liveRaw = new Uint8Array(await res.arrayBuffer());
  const live = parseManifest(new TextDecoder().decode(liveRaw));
  const liveHash = await sha256Hex(liveRaw);

  const repo = values.repo ?? live.repo;
  const ref = values.ref ?? live.commit;
  if (!repo) throw new Error('the manifest names no source repository: pass --repo <git URL or path>');
  if (!ref) throw new Error('the manifest names no commit: pass --ref <commit, tag or branch>');
  console.log(`site      ${base}`);
  console.log(`served    ${liveHash}`);
  if (values.name) {
    const parsed = parseRecord((await readRecordWithFallback(values.name, values.chain, values.rpc)).value);
    const anchored = !!parsed?.hashes.includes(liveHash);
    console.log(`anchor    ${values.name} (${values.chain}): ${anchored ? 'this build is anchored' : 'NOT anchored'}`);
    if (!anchored) process.exitCode = 1;
  }
  console.log(`source    ${repo} @ ${ref}`);

  const dir = await mkdtemp(join(tmpdir(), 'webseal-reproduce-'));
  try {
    const sh = (cmd: string, cwd = dir) => execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
    // LF on every OS: a Windows checkout must produce the bytes Linux CI built.
    sh(`git -c core.autocrlf=false clone --quiet ${JSON.stringify(repo)} .`);
    sh(`git -c advice.detachedHead=false checkout --quiet ${JSON.stringify(ref)}`);
    const commit = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
    if (live.commit && commit !== live.commit) throw new Error(`${ref} is ${commit}, but the site says it was built from ${live.commit}`);
    console.log(`commit    ${commit}`);
    console.log(`build     ${values.build}`);
    sh(values.build!);

    const dist = join(dir, values.dist!);
    if (!(await stat(dist).catch(() => null))?.isDirectory()) throw new Error(`the build produced no ${values.dist} directory`);
    // name, commit and repo are what the publisher declared, not build output: take them from the live manifest.
    const rebuilt = await manifestOf(dist, { name: live.name, commit: live.commit, repo: live.repo });
    const rebuiltHash = await manifestHash(rebuilt);

    const paths = Array.from(new Set([...Object.keys(live.files), ...Object.keys(rebuilt.files)])).sort();
    let differ = 0;
    for (const p of paths) {
      const a = live.files[p];
      const b = rebuilt.files[p];
      const s = a === b ? 'same    ' : !b ? 'NOT BUILT' : !a ? 'NOT LIVE' : 'DIFFERS ';
      if (a !== b) differ++;
      console.log(`  ${s} ${p}`);
    }
    if ((live.inline ?? []).join() !== (rebuilt.inline ?? []).join()) {
      differ++;
      console.log('  DIFFERS  inline scripts');
    }
    // The served files must also be the ones the manifest lists: check them, as verify does.
    const fetchPath = async (path: string) => {
      const r = await fetch(new URL(path, manifestUrl), { cache: 'no-store' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    };
    const served = summarize(await verifyFiles(live, Object.keys(live.files), fetchPath));
    console.log(`rebuilt   ${rebuiltHash}`);
    console.log(`files     ${served.bad ? `${served.bad} served file(s) differ from the manifest` : 'every served file matches the manifest'}`);
    const ok = rebuiltHash === liveHash && differ === 0 && served.bad === 0;
    console.log(`result    ${ok ? 'REPRODUCED: the site serves exactly what this commit builds to' : 'DIFFERENT: the site does not serve what this commit builds to'}`);
    if (!ok) process.exitCode = 1;
  } finally {
    if (values.keep) console.log(`kept      ${dir}`);
    else await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => console.log(`note      could not remove ${dir}`));
  }
}

async function hashFromArgs(values: { manifest?: string; hash?: string }): Promise<string> {
  if (values.hash) {
    const h = values.hash.toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('--hash must be 64 hex characters');
    return h;
  }
  const path = resolve(values.manifest ?? 'dist/.well-known/webseal.json');
  const text = await readFile(path, 'utf8');
  return manifestHash(parseManifest(text));
}

async function cmdPublish(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      ...NETWORK_OPTIONS,
      ...SIGNER_OPTIONS,
      manifest: { type: 'string' },
      hash: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'keep-current': { type: 'boolean', default: false },
      also: { type: 'string' },
    },
  });
  if (!values.name) throw new Error('--name is required');
  const hash = await hashFromArgs(values);
  // --keep-current: start a rollout. The record lists the new hash first and keeps the newest
  // current one, so the old build stays valid until the new one is live. Publish again
  // without the flag once the site serves the new build.
  let hashes = [hash];
  if (values['keep-current']) {
    const cur = parseRecord((await readRecord(values.name, values.chain, values.rpc)).value);
    if (cur && cur.hash !== hash) hashes = [hash, cur.hash];
  }
  // --also HEX: a second accepted build, named explicitly (for example two apps under one name).
  if (values.also) {
    const also = values.also.toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(also)) throw new Error('--also must be 64 hex characters');
    if (also !== hash) hashes = [hash, also];
  }
  const value = formatRecord(hashes);
  console.log(`name      ${values.name} (${values.chain})`);
  console.log(`record    ${value}`);
  if (values['dry-run'] && !values.as) return;
  const signer = signerFrom(values);
  const current = await readRecord(values.name, values.chain, values.rpc);
  if (current.value === value) {
    console.log(`unchanged the record already has this value; no transaction sent`);
    return;
  }
  const r = await writeRecord({ name: values.name, value, chainName: values.chain, rpc: values.rpc, signer });
  console.log(`resolver  ${r.v2 ? 'ENSv2 Permissioned Resolver' : 'ENSv1 resolver'}`);
  printTx(r);
  if (r.simulated) return;
  const after = await readRecord(values.name, values.chain, values.rpc);
  if (after.value !== value) throw new Error(`record reads back as ${after.value ?? '(none)'} after the transaction, expected ${value}`);
  console.log(`readback  ok`);
}

async function cmdRecord(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { name: { type: 'string' }, ...NETWORK_OPTIONS },
  });
  if (!values.name) throw new Error('--name is required');
  const r = await readRecordWithFallback(values.name, values.chain, values.rpc);
  console.log(`name      ${r.name} (${r.chain})`);
  if (r.from !== r.name) console.log(`found on  ${r.from}`);
  console.log(`record    ${r.value ?? '(none)'}`);
  const parsed = parseRecord(r.value);
  console.log(`hash      ${parsed ? parsed.hashes.join(', ') : '(unparseable or missing)'}`);
  if (parsed && parsed.hashes.length > 1) console.log('note      rollout in progress: both builds are accepted until the record is finalized');
  const w = await recordWriters(r.from, values.chain, values.rpc).catch(() => null);
  if (w?.v2) console.log(`writers   ${describeWriters(w)}`);
}

function describeWriters(w: { allRecords: number; thisRecordOnly: number }) {
  return `${w.allRecords} account(s) with every record, ${w.thisRecordOnly} with only this record (ENSv2 Permissioned Resolver)`;
}

async function cmdWriters(args: string[]) {
  const { values } = parseArgs({ args, options: { name: { type: 'string' }, check: { type: 'string', multiple: true }, ...NETWORK_OPTIONS } });
  if (!values.name) throw new Error('--name is required');
  const w = await recordWriters(values.name, values.chain, values.rpc, undefined, (values.check ?? []).map((a) => address(a, '--check')));
  console.log(`name      ${w.name} (${w.chain})`);
  console.log(`resolver  ${w.resolver} (${w.v2 ? 'ENSv2 Permissioned Resolver' : 'ENSv1: no per-record permissions'})`);
  if (!w.v2) return;
  console.log(`writers   ${describeWriters(w)}`);
  for (const a of w.accounts) console.log(`          ${a.address}  ${a.scope}`);
  if (!w.complete) {
    console.log(`          (${w.allRecords + w.thisRecordOnly - w.accounts.length} not identified: free public RPCs only serve recent logs.`);
    console.log('           Pass --rpc with your own node URL (Alchemy/Infura free tier) to list them, or --check an address.)');
  }
  if (w.allRecords > 1) {
    console.log(`warning   ${w.allRecords} accounts can change every record on this resolver, including webseal.`);
    console.log('          Each of them can anchor any build. Make sure you know all of them.');
  }
  for (const c of w.checks) console.log(`check     ${c.address} ${c.can ? 'CAN' : 'cannot'} change the record`);
}

async function cmdGrant(args: string[], grant: boolean) {
  const { values } = parseArgs({
    args,
    options: { name: { type: 'string' }, to: { type: 'string' }, from: { type: 'string' }, ...NETWORK_OPTIONS, ...SIGNER_OPTIONS },
  });
  if (!values.name) throw new Error('--name is required');
  const account = address(grant ? values.to : values.from, grant ? '--to' : '--from');
  const opts = { name: values.name, account, chainName: values.chain, rpc: values.rpc, signer: signerFrom(values) };
  console.log(`name      ${values.name} (${values.chain})`);
  console.log(`${grant ? 'grant' : 'revoke'}     ${account} (${grant ? 'to change only the webseal record' : 'from the webseal record'})`);
  const r = grant ? await grantRecordWriter(opts) : await revokeRecordWriter(opts);
  printTx(r);
  if (!r.simulated) console.log(`done      ${account} ${grant ? 'can now change only the webseal record' : 'can no longer change the webseal record'}`);
  if (grant) {
    console.log('note      grants cover every name served by this resolver: if the owner uses it for other');
    console.log('          names too, the key can set their webseal record as well. Give the app name its own resolver to avoid that.');
  }
}

async function cmdLink(args: string[]) {
  const { values } = parseArgs({ args, options: { name: { type: 'string' }, to: { type: 'string' }, ...NETWORK_OPTIONS, ...SIGNER_OPTIONS } });
  if (!values.name || !values.to) throw new Error('--name (the extra name) and --to (the name holding the record) are required');
  console.log(`link      ${values.name} -> ${values.to} (${values.chain}): one record, both names`);
  printTx(await linkNames({ source: values.name, target: values.to, chainName: values.chain, rpc: values.rpc, signer: signerFrom(values) }));
}

function icon(s: FileResult['status']) {
  return s === 'ok' ? 'ok      ' : s === 'mismatch' ? 'MISMATCH' : s === 'missing' ? 'MISSING ' : s === 'unlisted' ? 'UNLISTED' : 'ERROR   ';
}

async function cmdVerify(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      expect: { type: 'string' },
      chain: { type: 'string', default: 'sepolia' },
      rpc: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  const base = positionals[0];
  if (!base) throw new Error('URL is required');
  const origin = new URL(base);

  let expected: string | undefined;
  let accepted: string[] | undefined;
  let anchor: { kind: 'ens' | 'hash'; name?: string; from?: string; chain?: string } | undefined;
  if (values.expect) {
    expected = values.expect.toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('--expect must be 64 hex characters');
    anchor = { kind: 'hash' };
  } else if (values.name) {
    // Same lookup as the extension: the name, then webseal.<name>.
    const r = await readRecordWithFallback(values.name, values.chain, values.rpc);
    const parsed = parseRecord(r.value);
    if (!parsed) throw new Error(`no usable "webseal" text record on ${r.name} or webseal.${r.name} (${r.chain}): ${r.value ?? 'empty'}`);
    expected = parsed.hash;
    accepted = parsed.hashes;
    anchor = { kind: 'ens', name: r.name, from: r.from, chain: r.chain };
  } else {
    throw new Error('give --name app.eth (ENS anchor) or --expect HEX (manual anchor)');
  }

  const fetchPath = async (path: string): Promise<Uint8Array | null> => {
    const res = await fetch(new URL(path, origin), { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };

  const manifestRaw = await fetchPath(MANIFEST_PATH);
  if (!manifestRaw) throw new Error(`manifest not served at ${new URL(MANIFEST_PATH, origin)}`);
  const manifestText = new TextDecoder().decode(manifestRaw);
  const manifest = parseManifest(manifestText);
  const actual = await sha256Hex(manifestRaw);
  const manifestOk = (accepted ?? [expected]).includes(actual);

  const files = await verifyFiles(manifest, Object.keys(manifest.files), fetchPath);
  const { ok, bad } = summarize(files);
  const allOk = manifestOk && bad === 0;

  if (values.json) {
    console.log(JSON.stringify({ ok: allOk, anchor, manifest: { expected, actual, ok: manifestOk }, files }, null, 2));
  } else {
    console.log(`anchor    ${anchor.kind === 'ens' ? `${anchor.name} (${anchor.chain})${anchor.from !== anchor.name ? ` via ${anchor.from}` : ''}` : 'manual hash'}`);
    console.log(`manifest  ${manifestOk ? 'ok' : 'MISMATCH'}  expected ${expected}`);
    if (!manifestOk) console.log(`                       served   ${actual}`);
    for (const f of files) {
      console.log(`  ${icon(f.status)} ${f.path}` + (f.status === 'mismatch' ? `\n             expected ${f.expected}\n             served   ${f.actual}` : ''));
    }
    console.log(`result    ${allOk ? 'VERIFIED' : 'FAILED'}  (${ok} ok, ${bad} bad)`);
  }
  if (!allOk) process.exitCode = 1;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'build':
        return await cmdBuild(rest);
      case 'publish':
        return await cmdPublish(rest);
      case 'record':
        return await cmdRecord(rest);
      case 'verify':
        return await cmdVerify(rest);
      case 'reproduce':
        return await cmdReproduce(rest);
      case 'writers':
        return await cmdWriters(rest);
      case 'grant':
        return await cmdGrant(rest, true);
      case 'revoke':
        return await cmdGrant(rest, false);
      case 'link':
        return await cmdLink(rest);
      default:
        process.stdout.write(USAGE);
        if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 2;
    }
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const detail = /Details: (.*)/.exec(msg)?.[1];
    console.error(`error: ${msg.split('\n')[0]}${detail ? ` (${detail})` : ''}`);
    process.exitCode = 1;
  }
}
main();
