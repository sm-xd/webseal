import type { VerifyReport } from '@webseal/core';
import type { Msg, Pin, Settings, TabState } from './types.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (msg: Msg) => chrome.runtime.sendMessage(msg);

let tabId: number | undefined;
let host = '';
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
    summary.textContent = 'No trust anchor for this site. Pin an ENS name below to start verifying it.';
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
    host = new URL(tab?.url ?? '').host;
  } catch {
    host = '';
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
  if (!name.endsWith('.eth')) {
    $('summary').textContent = 'Enter an ENS name ending in .eth';
    return;
  }
  setPinAndReload({ kind: 'ens', name });
});
$('pinHash').addEventListener('click', async () => {
  const hash = state?.report?.manifest.actual;
  if (!hash) {
    // Not verified yet: fetch the served manifest directly.
    try {
      const res = await fetch(new URL('/.well-known/webseal.json', `http://${host}`), { cache: 'no-store' });
      const buf = await res.arrayBuffer();
      const d = await crypto.subtle.digest('SHA-256', buf);
      const h = Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
      return setPinAndReload({ kind: 'hash', hash: h });
    } catch {
      $('summary').textContent = 'This site does not serve /.well-known/webseal.json';
      return;
    }
  }
  setPinAndReload({ kind: 'hash', hash });
});
$('unpin').addEventListener('click', () => setPinAndReload(null));
$('recheck').addEventListener('click', async () => {
  if (tabId !== undefined) await chrome.tabs.reload(tabId);
  window.close();
});
$('saveSettings').addEventListener('click', async () => {
  const settings: Settings = { chain: $<HTMLSelectElement>('chain').value as Settings['chain'], rpc: $<HTMLInputElement>('rpc').value.trim() || undefined };
  await send({ type: 'setSettings', settings });
  $('summary').textContent = 'Saved. Reload the page to re-verify.';
});

load();
