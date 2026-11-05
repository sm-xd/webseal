/**
 * Isolated-world verifier. Runs at document_start, right after main.ts, in
 * every frame.
 * 1. Takes the private channel node main.ts left in the document (see channel.ts).
 * 2. Decides where this frame's verdict comes from:
 *    - a subframe that is same-origin with the top page inherits the top
 *      page's verdict (the top page's code can reach its wallet object);
 *    - a window opened by a same-origin page uses the worse of its own
 *      verdict and its opener's (the opener's code can reach it too);
 *    - everything else verifies itself.
 * 3. Verifying: get the anchor from the service worker, then after load hash
 *    the HTML document and every same-origin script and stylesheet and compare
 *    them with the served manifest, which must hash to the anchored value.
 *    Scripts and styles added later are checked incrementally.
 * 4. Reports to the service worker (badge, popup) and to main.ts (wallet gate).
 */
import {
  MANIFEST_PATH,
  normalizePath,
  parseManifest,
  sha256Hex,
  summarize,
  verifyDocument,
  verifyFiles,
  verifyInline,
  type FileResult,
  type Manifest,
  type VerifyReport,
} from '@webseal/core';
import { CHANNEL_TAG, EV_HELLO, EV_STATUS_PREFIX } from './channel.ts';
import type { Anchor, InheritFrom, InheritedMsg, Msg, PageStatus, RelatedFailedMsg } from './types.ts';

/* ---------- channel to main.ts ---------- */
const channel = document.querySelector(CHANNEL_TAG);
if (channel) {
  channel.remove();
  channel.dispatchEvent(new CustomEvent(EV_HELLO));
}
function tellPage(status: PageStatus, reason = '') {
  channel?.dispatchEvent(new CustomEvent(EV_STATUS_PREFIX + status, { detail: reason }));
}

function send(msg: Msg): Promise<unknown> {
  return chrome.runtime.sendMessage(msg).catch(() => undefined);
}

/* ---------- where does this frame's verdict come from ---------- */
// window.origin, not location.origin: about:blank, srcdoc and blob: frames
// have the URL origin "null" but really run with their creator's origin.
const myOrigin = window.origin;
const sameOrigin = (w: Window | null | undefined) => {
  try {
    return !!w && w !== window && myOrigin !== 'null' && w.origin === myOrigin;
  } catch {
    return false; // cross-origin: its code cannot reach our wallet object
  }
};
const isTop = window === window.top;
const inheritFrom: InheritFrom | null = !isTop ? (sameOrigin(window.top) ? 'top' : null) : sameOrigin(window.opener) ? 'opener' : null;

// The document as it was loaded, before any history.pushState() changes location.
const documentPath = location.pathname;

/* ---------- collection ---------- */
const isCodeLike = (p: string) => /\.(m?js|cjs|css|wasm|html?)$/i.test(p);
const CODE_INITIATORS = new Set(['script', 'link', 'css', 'other']);

/** Same-origin path to verify, cross-origin script URL to fail, or null to ignore. */
function classify(raw: string, kind: 'script' | 'other'): { path?: string; cross?: string } | null {
  let u: URL;
  try {
    u = new URL(raw, location.href);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (u.origin !== location.origin) return kind === 'script' ? { cross: u.href } : null;
  if (u.pathname === MANIFEST_PATH) return null;
  return { path: normalizePath(u.pathname) };
}

function resourceKind(e: PerformanceResourceTiming): 'script' | 'other' | null {
  let u: URL;
  try {
    u = new URL(e.name);
  } catch {
    return null;
  }
  if (e.initiatorType === 'script') return 'script';
  if (CODE_INITIATORS.has(e.initiatorType) && isCodeLike(u.pathname)) return 'other';
  // WebAssembly is fetched as data but runs as code.
  if ((e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') && /\.wasm$/i.test(u.pathname)) return 'script';
  return null; // other fetch, xmlhttprequest, beacon, img, ...: data, not code
}

function collect(): { paths: Set<string>; inline: string[]; cross: Set<string> } {
  const paths = new Set<string>();
  const inline: string[] = [];
  const cross = new Set<string>();
  const add = (raw: string, kind: 'script' | 'other') => {
    const c = classify(raw, kind);
    if (c?.path) paths.add(c.path);
    if (c?.cross) cross.add(c.cross);
  };
  for (const s of Array.from(document.scripts)) {
    const src = s.getAttribute('src');
    if (src) {
      add(src, 'script');
      continue;
    }
    const type = (s.getAttribute('type') ?? '').toLowerCase();
    if (/^(application\/(ld\+)?json|text\/template|importmap)$/.test(type)) continue;
    if (s.textContent && s.textContent.trim()) inline.push(s.textContent);
  }
  document
    .querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"],link[rel="modulepreload"],link[rel="preload"][as="script"]')
    .forEach((l) => l.href && add(l.href, 'other'));
  for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
    const k = resourceKind(e);
    if (k) add(e.name, k);
  }
  return { paths, inline, cross };
}

/** Scripts of this origin's service worker registrations: they run as code and can rewrite every response. */
async function serviceWorkerScripts(): Promise<string[]> {
  try {
    if (!navigator.serviceWorker) return [];
    const regs = await navigator.serviceWorker.getRegistrations();
    const out: string[] = [];
    for (const r of regs) for (const w of [r.installing, r.waiting, r.active]) if (w?.scriptURL) out.push(w.scriptURL);
    return out;
  } catch {
    return [];
  }
}

async function fetchSameOrigin(path: string): Promise<Uint8Array | null> {
  const res = await fetch(new URL(path, location.origin), { cache: 'force-cache', credentials: 'same-origin' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/* ---------- verification (incremental) ---------- */
let anchor: Anchor = { kind: 'none' };
let manifestState: { manifest?: Manifest; actual?: string; error?: string } | undefined;
let docResult: FileResult | undefined;
const fileResults = new Map<string, FileResult>();
const inlineResults = new Map<string, FileResult>();
const crossResults = new Map<string, FileResult>();
let lastReport: VerifyReport | undefined;
let everFailed = false;

function resetResults() {
  manifestState = undefined;
  docResult = undefined;
  fileResults.clear();
  inlineResults.clear();
  crossResults.clear();
}

async function verify(): Promise<VerifyReport> {
  const report: VerifyReport = {
    ok: false,
    anchor: anchor.kind === 'ens' ? { kind: 'ens', name: anchor.name, chain: anchor.chain, hash: anchor.hash, error: anchor.error } : anchor.kind === 'hash' ? { kind: 'hash', hash: anchor.hash } : { kind: 'none', error: anchor.note },
    manifest: { ok: false },
    files: [],
    inline: [],
    checkedAt: Date.now(),
  };
  if (anchor.kind === 'none') return report;
  const expected = anchor.hash;
  report.manifest.expected = expected;
  if (!expected) {
    report.manifest.error = anchor.kind === 'ens' ? anchor.error ?? 'no webseal record on this name' : 'no anchor';
    return report;
  }

  if (!manifestState) {
    try {
      const res = await fetch(new URL(MANIFEST_PATH, location.origin), { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(`manifest not served (HTTP ${res.status})`);
      const raw = new Uint8Array(await res.arrayBuffer());
      manifestState = { manifest: parseManifest(new TextDecoder().decode(raw)), actual: await sha256Hex(raw) };
    } catch (e) {
      manifestState = { error: (e as Error).message };
    }
  }
  if (manifestState.error || !manifestState.manifest) {
    report.manifest.error = manifestState.error;
    return report;
  }
  const manifest = manifestState.manifest;
  report.manifest.actual = manifestState.actual;
  // During a rollout the record lists the new and the previous release; either one passes.
  const accepted = anchor.kind === 'ens' && anchor.hashes?.length ? anchor.hashes : [expected];
  report.manifest.ok = !!manifestState.actual && accepted.includes(manifestState.actual);

  docResult ??= await verifyDocument(manifest, documentPath, fetchSameOrigin);

  const { paths, inline, cross } = collect();
  for (const url of await serviceWorkerScripts()) {
    const c = classify(url, 'script');
    if (c?.path) paths.add(c.path);
  }
  paths.delete(docResult.path);
  const fresh = Array.from(paths).filter((p) => !fileResults.has(p));
  if (fresh.length) for (const r of await verifyFiles(manifest, fresh, fetchSameOrigin)) fileResults.set(r.path, r);
  for (const href of cross) if (!crossResults.has(href)) crossResults.set(href, { path: href, status: 'unlisted', note: 'cross-origin script' });
  const freshInline = inline.filter((b) => !inlineResults.has(b));
  if (freshInline.length) {
    const rs = await verifyInline(manifest, freshInline);
    freshInline.forEach((b, i) => inlineResults.set(b, rs[i]));
  }

  report.files = [docResult, ...Array.from(fileResults.values()).sort((a, b) => a.path.localeCompare(b.path)), ...crossResults.values()];
  report.inline = Array.from(inlineResults.values()).map((r, i) => ({ ...r, path: `inline-script#${i}` }));
  const bad = summarize(report.files).bad + summarize(report.inline).bad;
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

/* ---------- banner ---------- */
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
let bannerHost: HTMLElement | undefined;
function showBanner(text: string, items: FileResult[]) {
  if (bannerHost) return;
  const host = document.createElement('div');
  host.id = 'webseal-banner';
  const pin = (prop: string, value: string) => host.style.setProperty(prop, value, 'important');
  pin('all', 'initial');
  pin('display', 'block');
  pin('position', 'sticky');
  pin('top', '0');
  pin('z-index', '2147483647');
  const root = host.attachShadow({ mode: 'closed' });
  const list = items
    .slice(0, 5)
    .map((f) => `<li><code>${escapeHtml(f.path)}</code> ${escapeHtml(f.status)}</li>`)
    .join('');
  root.innerHTML = `
    <style>
      .b{font:14px/1.4 system-ui,sans-serif;background:#b00020;color:#fff;padding:12px 16px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
      .b strong{font-size:15px} ul{margin:6px 0 0 18px;padding:0} code{font-family:ui-monospace,monospace;background:rgba(0,0,0,.25);padding:1px 4px;border-radius:3px}
    </style>
    <div class="b">
      <strong>WebSeal: this page's code does not match the build its publisher released.</strong>
      Wallet signing and transactions are blocked on this page.
      ${text ? `<div>${escapeHtml(text)}</div>` : ''}
      ${list ? `<ul>${list}</ul>` : ''}
    </div>`;
  bannerHost = host;
  const attach = () => {
    if (!host.isConnected) (document.body ?? document.documentElement).prepend(host);
  };
  attach();
  // Page code can remove the banner; put it back. The badge stays red regardless.
  new MutationObserver(attach).observe(document.documentElement, { childList: true, subtree: true });
}

/* ---------- reporting ---------- */
let ownStatus: PageStatus = 'pending';
let ownReason = '';
let inherited: { status: PageStatus; reason: string } | null = inheritFrom ? { status: 'pending', reason: '' } : null;

/* ---------- synchronous link between related pages ----------
 * Content scripts of one extension in same-origin frames share an isolated
 * world, so a subframe (or a window this page opened) can call this page's
 * verifier directly. It registers at document_start, before any of its own
 * page scripts run, and this page holds signing until it reports a verdict:
 * otherwise a tampered frame's code could use this page's wallet in the gap.
 * Page code cannot see this object; it lives in the isolated world only.
 */
const RELATED_KEY = '__websealRelated';
type RelatedApi = {
  register(token: object, hold: boolean): void;
  update(token: object, status: PageStatus | 'gone', reason: string): void;
  current(): { status: PageStatus; reason: string };
};
const children = new Map<object, PageStatus>();

/** Own verdict combined with the inherited one (what related pages inherit). */
function combineOwn(): { status: PageStatus; reason: string } {
  const own = { status: ownStatus, reason: ownReason };
  if (!inherited) return own;
  const list = [own, inherited];
  return list.find((x) => x.status === 'fail') ?? list.find((x) => x.status === 'pending') ?? list.find((x) => x.status === 'ok') ?? own;
}

/** What this page's wallet gate uses: also held while a related frame or window is unverified. */
function combine(): { status: PageStatus; reason: string } {
  const c = combineOwn();
  if (c.status !== 'fail' && Array.from(children.values()).includes('pending')) return { status: 'pending', reason: '' };
  return c;
}

const relatedApi: RelatedApi = {
  register(token, hold) {
    children.set(token, hold ? 'pending' : 'unknown');
    publish();
  },
  update(token, status, reason) {
    const was = children.get(token);
    if (was === undefined) return;
    if (status === 'gone') {
      children.delete(token);
      // It may have planted code in this page before it could be checked.
      if (was === 'pending') relatedFailed('A same-origin frame or window went away before it could be verified.');
      else publish();
      return;
    }
    children.set(token, status);
    if (status === 'fail') relatedFailed(`A same-origin frame or window failed: ${reason}`);
    else publish();
  },
  current: () => combineOwn(),
};
try {
  Object.defineProperty(window, RELATED_KEY, { value: relatedApi, enumerable: false, configurable: false, writable: false });
} catch {
  /* already defined by an earlier injection */
}

// Our side of the link, when this frame or window inherits.
const relatedWin = inheritFrom === 'top' ? window.top : inheritFrom === 'opener' ? window.opener : null;
let parentApi: RelatedApi | undefined;
try {
  parentApi = relatedWin ? ((relatedWin as unknown as Record<string, RelatedApi>)[RELATED_KEY] ?? undefined) : undefined;
} catch {
  parentApi = undefined;
}
const childToken = {};
// about:blank, srcdoc and blob: documents hold only code the related page wrote into them,
// so they do not hold that page's signing; documents loaded from a URL do until verified.
const ownDocument = /^https?:$/.test(location.protocol);
try {
  parentApi?.register(childToken, ownDocument);
  const cur = parentApi?.current();
  if (cur && cur.status !== 'pending') inherited = { status: cur.status, reason: cur.reason };
} catch {
  parentApi = undefined;
}
window.addEventListener('pagehide', () => {
  try {
    parentApi?.update(childToken, 'gone', '');
  } catch {
    /* related page already gone */
  }
});
function tellParent(status: PageStatus, reason: string) {
  try {
    parentApi?.update(childToken, status, reason);
  } catch {
    parentApi = undefined;
  }
}

let lastTold = '';
function publish() {
  const { status, reason } = combine();
  const key = status + '|' + reason;
  if (key === lastTold) return;
  lastTold = key;
  tellPage(status, status === 'fail' ? reason || 'Verification failed.' : '');
  if (status === 'fail' && inheritFrom !== 'top') showBanner(reason, lastReport ? [...lastReport.files, ...lastReport.inline].filter((f) => f.status !== 'ok') : []);
}

async function run(): Promise<PageStatus> {
  const report = await verify();
  lastReport = report;
  let status: PageStatus = anchor.kind === 'none' ? 'unknown' : report.ok ? 'ok' : 'fail';
  // A page that failed has run untrusted code; re-checks cannot clear that.
  if (everFailed) status = 'fail';
  ownStatus = status;
  ownReason = status === 'fail' ? failureReason(report) || ownReason || 'Verification failed.' : '';
  if (status === 'fail' && !everFailed && inheritFrom && !parentApi) {
    // No direct link (should not happen for same-origin pages): go through the service worker.
    send({ type: 'relatedFailed', reason: `${inheritFrom === 'top' ? 'A frame' : 'A window'} opened from this page failed: ${ownReason}` });
  }
  if (status === 'fail') everFailed = true;
  // Our code can reach the related page's wallet too (same origin): it holds or fails on our verdict.
  tellParent(status, ownReason);
  if (isTop) await send({ type: 'report', report, status, reason: ownReason });
  publish();
  return status;
}

/** A same-origin frame or window that can reach this page failed verification. */
async function relatedFailed(reason: string) {
  if (everFailed) return;
  everFailed = true;
  ownStatus = 'fail';
  ownReason = reason;
  const report = lastReport ?? { ok: false, anchor: { kind: 'none' as const }, manifest: { ok: false }, files: [], inline: [], checkedAt: Date.now() };
  report.ok = false;
  report.manifest.error ??= reason;
  lastReport = report;
  await send({ type: 'report', report, status: 'fail', reason });
  publish();
}

/* ---------- re-verification on new code ---------- */
function watch() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer || everFailed) return;
    timer = setTimeout(async () => {
      timer = undefined;
      await run();
    }, 200);
  };
  const isNew = (raw: string, kind: 'script' | 'other') => {
    const c = classify(raw, kind);
    return !!c && ((!!c.path && !fileResults.has(c.path) && c.path !== docResult?.path) || (!!c.cross && !crossResults.has(c.cross)));
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of Array.from(m.addedNodes)) {
        if (n instanceof HTMLScriptElement) {
          const src = n.getAttribute('src');
          if (src ? isNew(src, 'script') : !!n.textContent?.trim()) return schedule();
        } else if (n instanceof HTMLLinkElement && n.href && isNew(n.href, 'other')) return schedule();
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as PerformanceResourceTiming[]) {
      const k = resourceKind(e);
      if (k && isNew(e.name, k)) return schedule();
    }
  }).observe({ type: 'resource', buffered: false });
  try {
    navigator.serviceWorker?.addEventListener('controllerchange', schedule);
    // A new registration does not take control right away; poll briefly after it is created.
    const swTimer = setInterval(async () => {
      for (const u of await serviceWorkerScripts()) if (isNew(u, 'script')) return schedule();
    }, 2000);
    window.addEventListener('pagehide', () => clearInterval(swTimer));
  } catch {
    /* no service worker support */
  }
}

/**
 * Ask the service worker for this host's anchor. Only an explicit answer counts:
 * a failed message is retried, and if the worker never answers the result is a
 * failure, not "no anchor", which would let signing through on an anchored site.
 */
async function requestAnchor(fresh = false): Promise<Anchor | { kind: 'unreachable' }> {
  for (let i = 0; i < 4; i++) {
    const a = (await send({ type: 'anchor', host: location.host, fresh })) as Anchor | { error?: string } | undefined;
    if (a && 'kind' in a) return a;
    await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }
  return { kind: 'unreachable' };
}

const onReady = () =>
  new Promise<void>((resolve) => {
    if (document.readyState === 'complete') resolve();
    else window.addEventListener('load', () => resolve(), { once: true });
  });

async function start() {
  if (isTop) await send({ type: 'report', report: undefined, status: 'pending' });
  if (inheritFrom && inherited?.status === 'pending') {
    const s = (await send({ type: 'getInherited', from: inheritFrom })) as { status: PageStatus; reason?: string } | null | undefined;
    if (s && s.status !== 'pending' && inherited?.status === 'pending') inherited = { status: s.status, reason: s.reason ?? '' };
  }
  const got = await requestAnchor();
  if (got.kind === 'unreachable') {
    ownStatus = 'fail';
    ownReason = 'WebSeal could not reach its background worker, so this page could not be checked. Reload the page.';
    everFailed = true;
    tellParent('fail', ownReason);
    return publish();
  }
  anchor = got;
  if (anchor.kind === 'none') {
    ownStatus = 'unknown';
    lastReport = { ok: false, anchor: { kind: 'none', error: anchor.note }, manifest: { ok: false }, files: [], inline: [], checkedAt: Date.now() };
    if (isTop) await send({ type: 'report', report: lastReport, status: 'unknown' });
    tellParent('unknown', '');
    return publish();
  }
  // A frame holds its related page's signing until verified, so do not wait
  // forever for a frame that never finishes loading.
  await (inheritFrom ? Promise.race([onReady(), new Promise((r) => setTimeout(r, 5000))]) : onReady());
  // Give late module graphs and injected tags a moment to land in the timeline.
  await new Promise((r) => setTimeout(r, 150));
  if ((await run()) === 'ok') watch();
}
start();

chrome.runtime.onMessage.addListener((msg: Msg | InheritedMsg | RelatedFailedMsg, _sender, respond) => {
  if (msg.type === 'relatedFailed') {
    if (isTop) relatedFailed(msg.reason);
    return false;
  }
  if (msg.type === 'inherited') {
    if (msg.from === inheritFrom && inherited && msg.status !== 'pending') {
      inherited = { status: msg.status, reason: msg.reason };
      publish();
    }
    return false;
  }
  if (msg.type === 'recheck') {
    if (!isTop) return false;
    (async () => {
      // Fresh anchor (bypassing the ENS cache), fresh manifest, every file again.
      const got = await requestAnchor(true);
      if (got.kind !== 'unreachable') anchor = got;
      resetResults();
      const status = await run();
      respond({ status, report: lastReport });
    })();
    return true;
  }
  return false;
});
