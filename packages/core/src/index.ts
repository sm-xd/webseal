/**
 * @webseal/core
 *
 * Shared logic for the CLI and the browser extension. Runs in Node 22,
 * browser pages and extension service workers: only Web Crypto and fetch.
 */

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
  /** Git commit the build came from. Informational. */
  commit?: string;
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
  anchor: { kind: 'ens' | 'hash' | 'none'; name?: string; hash?: string; chain?: string; error?: string };
  manifest: { expected?: string; actual?: string; ok: boolean; error?: string };
  files: FileResult[];
  inline: FileResult[];
  checkedAt: number;
}

/* ---------- hashing ---------- */

const te = new TextEncoder();

export async function sha256Hex(data: BufferSource | Uint8Array | string): Promise<string> {
  const bytes = (typeof data === 'string' ? te.encode(data) : data) as BufferSource;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
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

export function formatRecord(hash: string): string {
  return RECORD_PREFIX + hash.toLowerCase();
}

export function parseRecord(value: string | null | undefined): { hash: string } | null {
  if (!value) return null;
  const v = value.trim();
  if (!v.startsWith(RECORD_PREFIX)) return null;
  const hash = v.slice(RECORD_PREFIX.length).toLowerCase();
  return /^[0-9a-f]{64}$/.test(hash) ? { hash } : null;
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
