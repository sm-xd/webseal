/**
 * @webseal/core
 *
 * Shared logic for the CLI and the browser extension. Runs in Node 22,
 * browser pages and extension service workers: only Web Crypto and fetch.
 */

import type { RecordWriters } from './ensv2.ts';

export const RECORD_KEY = 'webseal';
export const MANIFEST_PATH = '/.well-known/webseal.json';
export const RECORD_PREFIX = 'v1:sha256:';

/** Wallet RPC methods that can move money or sign. Gated while a page is unverified. */
export const SIGNING_METHODS: readonly string[] = [
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sendRawTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v1',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'wallet_sendCalls',
  'wallet_sendTransaction',
];

export interface Manifest {
  version: 1;
  /** ENS name the publisher intends this build to be anchored to. Informational. */
  name?: string;
  /** Git commit the build came from. `webseal reproduce` rebuilds it. */
  commit?: string;
  /** Public source repository (git URL) the build came from. `webseal reproduce` clones it. */
  repo?: string;
  /** Absolute URL path -> lowercase hex sha256 of the file bytes. */
  files: Record<string, string>;
  /** sha256 of allowed inline <script> bodies found in the HTML files. */
  inline?: string[];
}

export type FileStatus = 'ok' | 'mismatch' | 'missing' | 'unlisted' | 'fetch-error';

export interface FileResult {
  path: string;
  status: FileStatus;
  expected?: string;
  actual?: string;
  note?: string;
}

export interface VerifyReport {
  ok: boolean;
  /** Where the expected manifest hash came from. */
  anchor: { kind: 'ens' | 'hash' | 'none'; name?: string; hash?: string; chain?: string; error?: string; writers?: RecordWriters };
  manifest: { expected?: string; actual?: string; ok: boolean; error?: string };
  files: FileResult[];
  inline: FileResult[];
  checkedAt: number;
}

/* ---------- hashing ---------- */

const te = new TextEncoder();

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data: BufferSource | Uint8Array | string): Promise<string> {
  const bytes = (typeof data === 'string' ? te.encode(data) : data) as BufferSource;
  // Web Crypto only exists in secure contexts; plain-http pages fall back to the JS version.
  if (typeof crypto === 'undefined' || !crypto.subtle) return sha256HexJs(bytes);
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Plain-JS SHA-256 (FIPS 180-4), used where Web Crypto is unavailable. Exported for tests. */
export function sha256HexJs(data: BufferSource | Uint8Array): string {
  const msg =
    data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data as ArrayBuffer);
  const len = msg.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000), false);
  view.setUint32(padded.length - 4, (len << 3) >>> 0, false);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i], false);
  return toHex(out);
}

/** Deterministic JSON: keys sorted at every level, no whitespace. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

export function manifestBytes(m: Manifest): string {
  return canonicalize(m);
}

export async function manifestHash(m: Manifest): Promise<string> {
  return sha256Hex(manifestBytes(m));
}

/* ---------- ENS record encoding ---------- */

/** Most hashes a record may carry: the current release and the one being rolled out. */
export const MAX_RECORD_HASHES = 2;

/**
 * `v1:sha256:<hash>`, or during a rollout `v1:sha256:<new>,<old>`: a deploy is
 * not atomic with the ENS transaction, so for a short window both builds are
 * accepted instead of every visitor seeing red.
 */
export function formatRecord(hash: string | string[]): string {
  const list = (Array.isArray(hash) ? hash : [hash]).map((h) => h.toLowerCase());
  const unique = list.filter((h, i) => list.indexOf(h) === i);
  if (!unique.length || unique.length > MAX_RECORD_HASHES) throw new Error(`a record carries 1 to ${MAX_RECORD_HASHES} hashes`);
  return RECORD_PREFIX + unique.join(',');
}

/** `hash` is the first (newest) entry; `hashes` lists every accepted manifest hash. */
export function parseRecord(value: string | null | undefined): { hash: string; hashes: string[] } | null {
  if (!value) return null;
  const v = value.trim();
  if (!v.startsWith(RECORD_PREFIX)) return null;
  const hashes = v.slice(RECORD_PREFIX.length).toLowerCase().split(',');
  if (hashes.length > MAX_RECORD_HASHES || !hashes.every((h) => /^[0-9a-f]{64}$/.test(h))) return null;
  return { hash: hashes[0], hashes };
}

/* ---------- paths ---------- */

/** "/foo/?x=1#y" -> "/foo/index.html", "" -> "/index.html", "/a.js?v=2" -> "/a.js" */
export function normalizePath(p: string): string {
  let path = p;
  try {
    if (/^[a-z]+:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    /* keep as is */
  }
  path = path.split('#')[0].split('?')[0];
  if (!path.startsWith('/')) path = '/' + path;
  path = path.replace(/\/{2,}/g, '/');
  if (path.endsWith('/')) path += 'index.html';
  try {
    path = decodeURI(path);
  } catch {
    /* keep encoded */
  }
  return path;
}

/** Derive an ENS name from gateway hostnames such as app.eth.limo -> app.eth */
export function deriveNameFromHost(host: string): string | null {
  const h = host.toLowerCase().split(':')[0];
  const m = h.match(/^(.+\.eth)\.(limo|link|sucks)$/);
  return m ? m[1] : null;
}

/* ---------- verification ---------- */

export type Fetcher = (path: string) => Promise<Uint8Array | null>;

export function parseManifest(text: string): Manifest {
  const m = JSON.parse(text) as Manifest;
  if (m.version !== 1 || typeof m.files !== 'object' || m.files === null) {
    throw new Error('not a webseal v1 manifest');
  }
  for (const [p, h] of Object.entries(m.files)) {
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`bad hash for ${p}`);
  }
  return m;
}

/**
 * Compare a set of loaded paths against the manifest. Paths not in the
 * manifest are reported as "unlisted", which is a failure: an injected script
 * is exactly that.
 */
export async function verifyFiles(manifest: Manifest, paths: Iterable<string>, fetcher: Fetcher): Promise<FileResult[]> {
  const unique = Array.from(new Set(Array.from(paths, normalizePath)));
  const results: FileResult[] = [];
  await Promise.all(
    unique.map(async (path) => {
      const expected = manifest.files[path];
      if (!expected) {
        results.push({ path, status: 'unlisted' });
        return;
      }
      let bytes: Uint8Array | null;
      try {
        bytes = await fetcher(path);
      } catch (e) {
        results.push({ path, status: 'fetch-error', expected, note: String(e) });
        return;
      }
      if (!bytes) {
        results.push({ path, status: 'missing', expected });
        return;
      }
      const actual = await sha256Hex(bytes);
      results.push({ path, status: actual === expected ? 'ok' : 'mismatch', expected, actual });
    }),
  );
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Verify the HTML document a page was loaded from. A path listed in the
 * manifest is checked as usual. A path that is not (a client-side route such
 * as /dashboard, served by the host's SPA fallback or a rewrite) passes only if
 * the served bytes are identical to one of the release's HTML files.
 */
export async function verifyDocument(manifest: Manifest, rawPath: string, fetcher: Fetcher): Promise<FileResult> {
  const path = normalizePath(rawPath);
  if (manifest.files[path]) return (await verifyFiles(manifest, [path], fetcher))[0];
  let bytes: Uint8Array | null;
  try {
    bytes = await fetcher(path);
  } catch (e) {
    return { path, status: 'fetch-error', note: String(e) };
  }
  if (!bytes) return { path, status: 'missing' };
  const actual = await sha256Hex(bytes);
  for (const [p, h] of Object.entries(manifest.files)) {
    if (/\.html?$/i.test(p) && h === actual) return { path, status: 'ok', expected: h, actual, note: `served as ${p}` };
  }
  return { path, status: 'unlisted', actual, note: 'route not in the release and its HTML matches no release page' };
}

/** Inline script bodies must match one of the manifest's allowed hashes. */
export async function verifyInline(manifest: Manifest, bodies: Iterable<string>): Promise<FileResult[]> {
  const allowed = new Set(manifest.inline ?? []);
  const out: FileResult[] = [];
  let i = 0;
  for (const body of bodies) {
    const actual = await sha256Hex(body);
    out.push({
      path: `inline-script#${i++}`,
      status: allowed.has(actual) ? 'ok' : 'unlisted',
      actual,
      note: body.slice(0, 80).replace(/\s+/g, ' '),
    });
  }
  return out;
}

export function summarize(files: FileResult[]): { ok: number; bad: number } {
  let ok = 0;
  let bad = 0;
  for (const f of files) (f.status === 'ok' ? ok++ : bad++);
  return { ok, bad };
}

/** Extract inline <script> bodies from an HTML string (no src attribute). */
export function extractInlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (/\ssrc\s*=/i.test(attrs)) continue;
    if (/type\s*=\s*["']?(application\/(ld\+)?json|text\/template|importmap)/i.test(attrs)) continue;
    if (m[2].trim().length === 0) continue;
    out.push(m[2]);
  }
  return out;
}

export * from './ensv2.ts';
