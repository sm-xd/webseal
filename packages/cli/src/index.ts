import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
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
import { readRecord, writeRecord } from './ens.ts';

const USAGE = `webseal: anchor a web frontend's build hash on ENS and verify what a server serves.

  webseal build   [--dist dist] [--name app.eth] [--out dist/.well-known/webseal.json] [--no-commit]
  webseal publish --name app.eth [--chain sepolia|mainnet] [--rpc URL] [--manifest path | --hash HEX] [--dry-run]
                  private key: --key 0x... or env WEBSEAL_PRIVATE_KEY
  webseal record  --name app.eth [--chain sepolia|mainnet] [--rpc URL]
  webseal verify  URL [--name app.eth | --expect HEX] [--chain sepolia|mainnet] [--rpc URL] [--json]
`;

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

async function cmdBuild(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      dist: { type: 'string', default: 'dist' },
      name: { type: 'string' },
      out: { type: 'string' },
      commit: { type: 'boolean', default: true },
    },
    allowNegative: true,
  });
  const dist = resolve(values.dist!);
  if (!(await stat(dist).catch(() => null))?.isDirectory()) throw new Error(`no such directory: ${dist}`);
  const out = resolve(values.out ?? join(dist, '.well-known', 'webseal.json'));
  const outRel = '/' + relative(dist, out).split(sep).join('/');

  const files: Record<string, string> = {};
  const inline = new Set<string>();
  for (const path of await walk(dist)) {
    if (path === outRel) continue; // the manifest never lists itself
    const bytes = await readFile(join(dist, path));
    files[path] = await sha256Hex(bytes);
    if (/\.html?$/i.test(path)) {
      for (const body of extractInlineScripts(bytes.toString('utf8'))) inline.add(await sha256Hex(body));
    }
  }
  const manifest: Manifest = { version: 1, files };
  if (values.name) manifest.name = values.name;
  if (values.commit) {
    const c = gitCommit();
    if (c) manifest.commit = c;
  }
  if (inline.size) manifest.inline = Array.from(inline).sort();

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, manifestBytes(manifest));
  const hash = await manifestHash(manifest);
  console.log(`manifest  ${out}`);
  console.log(`files     ${Object.keys(files).length}` + (inline.size ? `  inline scripts ${inline.size}` : ''));
  console.log(`hash      ${hash}`);
  console.log(`record    ${formatRecord(hash)}`);
  if (inline.size) console.log(`note      inline scripts were found; hashing them is a weaker guarantee than external files`);
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
      chain: { type: 'string', default: 'sepolia' },
      rpc: { type: 'string' },
      manifest: { type: 'string' },
      hash: { type: 'string' },
      key: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!values.name) throw new Error('--name is required');
  const hash = await hashFromArgs(values);
  const value = formatRecord(hash);
  console.log(`name      ${values.name} (${values.chain})`);
  console.log(`record    ${value}`);
  if (values['dry-run']) return;
  const key = (values.key ?? process.env.WEBSEAL_PRIVATE_KEY) as `0x${string}` | undefined;
  if (!key) throw new Error('private key missing: pass --key or set WEBSEAL_PRIVATE_KEY');
  const r = await writeRecord({ name: values.name, value, chainName: values.chain, rpc: values.rpc, privateKey: key });
  console.log(`from      ${r.from}`);
  console.log(`resolver  ${r.resolver}`);
  console.log(`tx        ${r.tx} (${r.status})`);
}

async function cmdRecord(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { name: { type: 'string' }, chain: { type: 'string', default: 'sepolia' }, rpc: { type: 'string' } },
  });
  if (!values.name) throw new Error('--name is required');
  const r = await readRecord(values.name, values.chain, values.rpc);
  console.log(`name      ${r.name} (${r.chain})`);
  console.log(`record    ${r.value ?? '(none)'}`);
  const parsed = parseRecord(r.value);
  console.log(`hash      ${parsed ? parsed.hash : '(unparseable or missing)'}`);
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
  let anchor: { kind: 'ens' | 'hash'; name?: string; chain?: string } | undefined;
  if (values.expect) {
    expected = values.expect.toLowerCase().replace(/^0x/, '');
    anchor = { kind: 'hash' };
  } else if (values.name) {
    const r = await readRecord(values.name, values.chain, values.rpc);
    const parsed = parseRecord(r.value);
    if (!parsed) throw new Error(`no usable "webseal" text record on ${r.name} (${r.chain}): ${r.value ?? 'empty'}`);
    expected = parsed.hash;
    anchor = { kind: 'ens', name: r.name, chain: r.chain };
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
  const manifestOk = actual === expected;

  const files = await verifyFiles(manifest, Object.keys(manifest.files), fetchPath);
  const { ok, bad } = summarize(files);
  const allOk = manifestOk && bad === 0;

  if (values.json) {
    console.log(JSON.stringify({ ok: allOk, anchor, manifest: { expected, actual, ok: manifestOk }, files }, null, 2));
  } else {
    console.log(`anchor    ${anchor.kind === 'ens' ? `${anchor.name} (${anchor.chain})` : 'manual hash'}`);
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
