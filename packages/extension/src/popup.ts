import { MANIFEST_PATH, parseManifest, sha256Hex, type VerifyReport } from '@webseal/core';
import type { Msg, Pin, Settings, TabState } from './types.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (msg: Msg) => chrome.runtime.sendMessage(msg);

let tabId: number | undefined;
let host = '';
let origin = '';
let state: TabState | null = null;

function short(h?: string) {
  return h ? h.slice(0, 10) + '…' + h.slice(-8) : '—';
}

function render() {
  const dot = $('dot');
  const summary = $('summary');
  const status = state?.status ?? 'unknown';
  dot.className = `dot ${status}`;
  summary.className = `summary ${status}`;
  const r: VerifyReport | undefined = state?.report;
  const anchorText =
    r?.anchor.kind === 'ens' ? `${r.anchor.name} (${r.anchor.chain}${r.anchor.error ? ', ' + r.anchor.error : ''})` : r?.anchor.kind === 'hash' ? 'pinned manifest hash' : 'none';
  if (status === 'unknown') {
    const note = r?.anchor.kind === 'none' && r.anchor.error ? ` (${r.anchor.error})` : '';
    summary.textContent = `No trust anchor for this site${note}. Pin an ENS name below to start verifying it.`;
    $('details').classList.add('hidden');
  } else if (status === 'pending') {
    summary.textContent = 'Verifying…';
    $('details').classList.add('hidden');
  } else if (r) {
    const bad = [...r.files, ...r.inline].filter((f) => f.status !== 'ok');
    const okCount = r.files.length + r.inline.length - bad.length;
    summary.textContent =
      status === 'ok'
        ? `Verified. ${okCount} file(s) match the release anchored on ${anchorText}.`
        : r.manifest.error
          ? `Blocked. ${r.manifest.error}`
          : !r.manifest.ok
            ? 'Blocked. The served manifest does not match the anchored hash.'
            : `Blocked. ${bad.length} file(s) differ from the release. Wallet signing is disabled on this page.`;
    $('details').classList.remove('hidden');
    $('anchor').textContent = anchorText;
    $('expected').textContent = short(r.manifest.expected);
    $('served').textContent = short(r.manifest.actual);
    const ul = $('files');
    ul.innerHTML = '';
    for (const f of [...r.files, ...r.inline]) {
      const li = document.createElement('li');
      li.className = f.status === 'ok' ? 'ok' : 'bad';
      const st = document.createElement('span');
      st.className = 'st';
      st.textContent = f.status;
      const p = document.createElement('span');
      p.textContent = f.path + (f.note && f.status !== 'ok' ? `  (${f.note})` : '');
      li.append(st, p);
      ul.append(li);
    }
  }
}

async function load() {
  // ?tab=<id> lets the popup be opened as a normal page for a given tab (screenshots, tests).
  const override = Number(new URLSearchParams(location.search).get('tab'));
  const tab = override ? await chrome.tabs.get(override) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  tabId = tab?.id;
  try {
    const u = new URL(tab?.url ?? '');
    host = /^https?:$/.test(u.protocol) ? u.host : '';
    origin = host ? u.origin : '';
  } catch {
    host = '';
    origin = '';
  }
  $('host').textContent = host || '(no page)';
  state = tabId !== undefined ? ((await send({ type: 'getStatus', tabId })) as TabState | null) : null;
  const pin = host ? ((await send({ type: 'getPin', host })) as Pin | null) : null;
  if (pin?.kind === 'ens') $<HTMLInputElement>('name').value = pin.name;
  const settings = (await send({ type: 'getSettings' })) as Settings;
  $<HTMLSelectElement>('chain').value = settings.chain;
  $<HTMLInputElement>('rpc').value = settings.rpc ?? '';
  render();
}

async function setPinAndReload(pin: Pin | null) {
  if (!host) return;
  await send({ type: 'setPin', host, pin });
  if (tabId !== undefined) await chrome.tabs.reload(tabId);
  window.close();
}

$('pinName').addEventListener('click', () => {
  const name = $<HTMLInputElement>('name').value.trim().toLowerCase();
  // ENS also resolves DNS names (example.com) and other TLDs, so any dotted name is accepted;
  // the service worker reports a lookup error if it does not resolve.
  if (!/^[^\s.]+(\.[^\s.]+)+$/.test(name)) {
    $('summary').textContent = 'Enter an ENS name, for example app.eth';
    return;
  }
  setPinAndReload({ kind: 'ens', name });
});
$('pinHash').addEventListener('click', async () => {
  const hash = state?.report?.manifest.actual;
  if (hash) return setPinAndReload({ kind: 'hash', hash });
  // Not verified yet: fetch the served manifest directly, from the tab's own origin.
  try {
    if (!origin) throw new Error('no page');
    const res = await fetch(new URL(MANIFEST_PATH, origin), { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = new Uint8Array(await res.arrayBuffer());
    parseManifest(new TextDecoder().decode(raw)); // refuse to pin something that is not a manifest
    return setPinAndReload({ kind: 'hash', hash: await sha256Hex(raw) });
  } catch (e) {
    $('summary').textContent = `This site does not serve a valid ${MANIFEST_PATH} (${(e as Error).message})`;
  }
});
$('unpin').addEventListener('click', () => setPinAndReload(null));
$('recheck').addEventListener('click', async () => {
  if (tabId === undefined) return;
  $('summary').textContent = 'Re-checking…';
  // Re-verify in place: fresh ENS lookup, fresh manifest, every file again. A
  // page that already failed stays failed until it is reloaded.
  const r = (await chrome.tabs.sendMessage(tabId, { type: 'recheck' } satisfies Msg, { frameId: 0 }).catch(() => null)) as { status?: string } | null;
  if (!r?.status) {
    await chrome.tabs.reload(tabId); // no verifier in the tab (e.g. it was open before install)
    return window.close();
  }
  state = (await send({ type: 'getStatus', tabId })) as TabState | null;
  render();
});
$('saveSettings').addEventListener('click', async () => {
  const settings: Settings = { chain: $<HTMLSelectElement>('chain').value as Settings['chain'], rpc: $<HTMLInputElement>('rpc').value.trim() || undefined };
  await send({ type: 'setSettings', settings });
  $('summary').textContent = 'Saved. Reload the page to re-verify.';
});

load();
