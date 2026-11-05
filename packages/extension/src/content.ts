/**
 * Isolated-world verifier. Runs at document_start, right after main.ts.
 * 1. Takes the one-time token main.ts left on <html> and deletes it.
 * 2. Asks the service worker for this host's anchor (ENS record or pinned hash).
 * 3. After load, hashes every same-origin script, stylesheet and the HTML
 *    document itself and compares them with the served manifest, which in turn
 *    must hash to the anchored value.
 * 4. Reports to the service worker (badge, popup) and to main.ts (wallet gate).
 */
import {
  MANIFEST_PATH,
  normalizePath,
  parseManifest,
  sha256Hex,
  summarize,
  verifyFiles,
  verifyInline,
  type FileResult,
  type Manifest,
  type VerifyReport,
} from '@webseal/core';
import type { Anchor, Msg, PageStatus } from './types.ts';

const token = document.documentElement.getAttribute('data-webseal-token') ?? '';
document.documentElement.removeAttribute('data-webseal-token');

let seq = 0;
async function tellPage(status: PageStatus, reason = '') {
  if (!token) return;
  const key = await sha256Hex(`${token}:${seq}`);
  window.postMessage({ type: 'webseal:status', seq, key, status, reason }, '*');
  seq++;
}

function send(msg: Msg): Promise<unknown> {
  return chrome.runtime.sendMessage(msg).catch(() => undefined);
}

const isCodeLike = (p: string) => /\.(m?js|cjs|css|wasm|html?)$/i.test(p);

function collect(): { paths: Set<string>; inline: string[]; cross: string[] } {
  const paths = new Set<string>([normalizePath(location.pathname)]);
  const inline: string[] = [];
  const cross: string[] = [];
  const addUrl = (raw: string, kind: 'script' | 'other') => {
    let u: URL;
    try {
      u = new URL(raw, location.href);
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol)) return;
    if (u.origin !== location.origin) {
      if (kind === 'script') cross.push(u.href);
      return;
    }
    if (u.pathname === MANIFEST_PATH) return;
    paths.add(normalizePath(u.pathname));
  };
  for (const s of Array.from(document.scripts)) {
    const src = s.getAttribute('src');
    if (src) {
      addUrl(src, 'script');
      continue;
    }
    const type = (s.getAttribute('type') ?? '').toLowerCase();
    if (/^(application\/(ld\+)?json|text\/template|importmap)$/.test(type)) continue;
    if (s.textContent && s.textContent.trim()) inline.push(s.textContent);
  }
  document
    .querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"],link[rel="modulepreload"],link[rel="preload"][as="script"]')
    .forEach((l) => l.href && addUrl(l.href, 'other'));
  for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
    const kind = e.initiatorType;
    let u: URL;
    try {
      u = new URL(e.name);
    } catch {
      continue;
    }
    if (kind === 'script' || kind === 'link' || kind === 'css' || kind === 'other' || isCodeLike(u.pathname)) {
      if (kind === 'fetch' || kind === 'xmlhttprequest' || kind === 'beacon') continue;
      if (!isCodeLike(u.pathname) && kind !== 'script') continue;
      addUrl(e.name, kind === 'script' ? 'script' : 'other');
    }
  }
  return { paths, inline, cross };
}

async function fetchSameOrigin(path: string): Promise<Uint8Array | null> {
  const res = await fetch(new URL(path, location.origin), { cache: 'force-cache', credentials: 'same-origin' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

let manifestCache: { manifest: Manifest; actual: string } | undefined;
let lastReport: VerifyReport | undefined;
let anchor: Anchor = { kind: 'none' };

async function verify(reason: 'load' | 'mutation' | 'recheck'): Promise<VerifyReport> {
  const report: VerifyReport = {
    ok: false,
    anchor: anchor.kind === 'ens' ? { kind: 'ens', name: anchor.name, chain: anchor.chain, hash: anchor.hash, error: anchor.error } : anchor,
    manifest: { ok: false },
    files: [],
    inline: [],
    checkedAt: Date.now(),
  };
  if (anchor.kind === 'none') return report;
  const expected = anchor.kind === 'hash' ? anchor.hash : anchor.hash;
  report.manifest.expected = expected;
  if (!expected) {
    report.manifest.error = anchor.kind === 'ens' ? anchor.error ?? 'no webseal record on this name' : 'no anchor';
    return report;
  }

  try {
    if (!manifestCache || reason === 'recheck') {
      const res = await fetch(new URL(MANIFEST_PATH, location.origin), { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(`manifest not served (HTTP ${res.status})`);
      const raw = new Uint8Array(await res.arrayBuffer());
      const manifest = parseManifest(new TextDecoder().decode(raw));
      manifestCache = { manifest, actual: await sha256Hex(raw) };
    }
  } catch (e) {
    report.manifest.error = (e as Error).message;
    return report;
  }
  report.manifest.actual = manifestCache.actual;
  report.manifest.ok = manifestCache.actual === expected;

  const { paths, inline, cross } = collect();
  const files = await verifyFiles(manifestCache.manifest, paths, fetchSameOrigin);
  for (const href of cross) files.push({ path: href, status: 'unlisted', note: 'cross-origin script' });
  report.files = files;
  report.inline = await verifyInline(manifestCache.manifest, inline);
  const bad = summarize(files).bad + summarize(report.inline).bad;
  report.ok = report.manifest.ok && bad === 0;
  return report;
}

function failureReason(r: VerifyReport): string {
  if (r.manifest.error) return r.manifest.error;
  if (r.manifest.expected && !r.manifest.ok) return 'The served manifest does not match the anchored hash.';
  const bad = [...r.files, ...r.inline].filter((f) => f.status !== 'ok');
  if (!bad.length) return '';
  const first = bad[0];
  const label = first.status === 'mismatch' ? 'changed' : first.status === 'unlisted' ? 'not in the release' : first.status;
  return `${bad.length} file(s) failed. First: ${first.path} (${label}).`;
}

let bannerShown = false;
function showBanner(r: VerifyReport) {
  if (bannerShown) return;
  bannerShown = true;
  const host = document.createElement('div');
  host.id = 'webseal-banner';
  host.style.cssText = 'all:initial;display:block;position:sticky;top:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  const bad = [...r.files, ...r.inline].filter((f) => f.status !== 'ok');
  const list = bad
    .slice(0, 5)
    .map((f: FileResult) => `<li><code>${f.path}</code> ${f.status}</li>`)
    .join('');
  root.innerHTML = `
    <style>
      .b{font:14px/1.4 system-ui,sans-serif;background:#b00020;color:#fff;padding:12px 16px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
      .b strong{font-size:15px} ul{margin:6px 0 0 18px;padding:0} code{font-family:ui-monospace,monospace;background:rgba(0,0,0,.25);padding:1px 4px;border-radius:3px}
    </style>
    <div class="b">
      <strong>WebSeal: this page's code does not match the build its publisher released.</strong>
      Wallet signing and transactions are blocked on this page. ${r.manifest.error ? `<div>${r.manifest.error}</div>` : ''}
      ${r.manifest.expected && !r.manifest.ok && !r.manifest.error ? '<div>The served manifest does not match the anchored hash.</div>' : ''}
      ${list ? `<ul>${list}</ul>` : ''}
    </div>`;
  (document.body ?? document.documentElement).prepend(host);
}

async function run(reason: 'load' | 'mutation' | 'recheck') {
  const report = await verify(reason);
  lastReport = report;
  const status: PageStatus = anchor.kind === 'none' ? 'unknown' : report.ok ? 'ok' : 'fail';
  await send({ type: 'report', report, status });
  await tellPage(status, status === 'fail' ? failureReason(report) : '');
  if (status === 'fail') showBanner(report);
  return status;
}

const onReady = () =>
  new Promise<void>((resolve) => {
    if (document.readyState === 'complete') resolve();
    else window.addEventListener('load', () => resolve(), { once: true });
  });

(async () => {
  await send({ type: 'report', report: undefined as unknown as VerifyReport, status: 'pending' });
  anchor = ((await send({ type: 'anchor', host: location.host })) as Anchor | undefined) ?? { kind: 'none' };
  if (anchor.kind === 'none') {
    await send({ type: 'report', report: { ok: false, anchor, manifest: { ok: false }, files: [], inline: [], checkedAt: Date.now() }, status: 'unknown' });
    await tellPage('unknown');
    return;
  }
  await onReady();
  // Give late module graphs and injected tags a moment to land in the timeline.
  await new Promise((r) => setTimeout(r, 150));
  const status = await run('load');

  if (status === 'ok') {
    // Scripts added after load (dynamic import, injected tags) are re-checked.
    let pending = false;
    const mo = new MutationObserver((muts) => {
      if (pending) return;
      if (!muts.some((m) => Array.from(m.addedNodes).some((n) => n.nodeName === 'SCRIPT' || n.nodeName === 'LINK'))) return;
      pending = true;
      setTimeout(async () => {
        pending = false;
        const s = await run('mutation');
        if (s === 'fail') mo.disconnect();
      }, 200);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    const po = new PerformanceObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(async () => {
        pending = false;
        const s = await run('mutation');
        if (s === 'fail') po.disconnect();
      }, 200);
    });
    po.observe({ type: 'resource', buffered: false });
  }
})();

chrome.runtime.onMessage.addListener((msg: Msg, _sender, respond) => {
  if (msg.type === 'recheck') {
    run('recheck').then((s) => respond({ status: s, report: lastReport }));
    return true;
  }
  return false;
});
