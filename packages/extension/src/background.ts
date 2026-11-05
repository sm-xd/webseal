import { deriveNameFromHost } from '@webseal/core';
import { resolveRecord } from './ens.ts';
import { DEFAULT_SETTINGS, type Anchor, type InheritedMsg, type Msg, type Pin, type RelatedFailedMsg, type Settings, type TabState } from './types.ts';

/* ---------- per-tab state ----------
 * Kept in chrome.storage.session, not in memory: Chrome stops an idle MV3
 * service worker after about 30 seconds, which would wipe a Map and leave the
 * popup saying "no trust anchor" next to a green badge. Session storage lives
 * until the browser closes and is not readable by content scripts.
 */
const tabKey = (id: number) => `tab:${id}`;
async function getTab(id: number): Promise<TabState | null> {
  const k = tabKey(id);
  return ((await chrome.storage.session.get(k))[k] as TabState | undefined) ?? null;
}
async function setTab(id: number, state: TabState) {
  await chrome.storage.session.set({ [tabKey(id)]: state });
}

async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}
async function getPins(): Promise<Record<string, Pin>> {
  const { pins } = await chrome.storage.local.get('pins');
  return (pins ?? {}) as Record<string, Pin>;
}

async function anchorFor(host: string, fresh: boolean): Promise<Anchor> {
  const pins = await getPins();
  const pin = pins[host];
  const settings = await getSettings();
  if (pin?.kind === 'hash') return { kind: 'hash', hash: pin.hash };
  const name = pin?.kind === 'ens' ? pin.name : deriveNameFromHost(host);
  if (!name) return { kind: 'none' };
  const r = await resolveRecord(name, settings, fresh);
  // A name derived from an *.eth.limo / *.eth.link host that never published a
  // record has not opted in: treat it like any unknown site, not as a failure.
  // A failed lookup still fails closed, since the site may have a record.
  if (!pin && r.notFound) return { kind: 'none', note: `${name} has no webseal record` };
  return { kind: 'ens', name, chain: settings.chain, hash: r.hash, hashes: r.hashes, error: r.error, derived: !pin };
}

function badge(tabId: number, state: TabState) {
  const map = {
    pending: { text: '…', color: '#777' },
    unknown: { text: '', color: '#777' },
    ok: { text: '✓', color: '#1a8f3c' },
    fail: { text: '✗', color: '#b00020' },
  } as const;
  const b = map[state.status];
  chrome.action.setBadgeText({ tabId, text: b.text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: b.color }).catch(() => {});
  chrome.action
    .setTitle({ tabId, title: `WebSeal: ${state.status}${state.report?.anchor.kind === 'ens' ? ` (${state.report.anchor.name})` : ''}` })
    .catch(() => {});
}

/** Tell same-origin subframes of this tab, and windows it opened, about its verdict. */
async function broadcast(tabId: number, state: TabState) {
  const base = { type: 'inherited' as const, status: state.status, reason: state.reason ?? '' };
  chrome.tabs.sendMessage(tabId, { ...base, from: 'top' } satisfies InheritedMsg).catch(() => {});
  const children = await chrome.tabs.query({});
  for (const t of children) {
    if (t.openerTabId === tabId && t.id !== undefined) chrome.tabs.sendMessage(t.id, { ...base, from: 'opener' } satisfies InheritedMsg).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg: Msg, sender, respond) => {
  (async () => {
    switch (msg.type) {
      case 'anchor':
        return anchorFor(msg.host, !!msg.fresh);
      case 'report': {
        const tabId = sender.tab?.id;
        if (tabId === undefined || sender.frameId !== 0) return;
        const state: TabState = {
          status: msg.status,
          reason: msg.reason,
          report: msg.report,
          host: new URL(sender.url ?? sender.tab?.url ?? 'http://x').host,
          url: sender.url ?? '',
        };
        await setTab(tabId, state);
        badge(tabId, state);
        if (msg.status !== 'pending') await broadcast(tabId, state);
        return;
      }
      case 'getInherited': {
        const tab = sender.tab;
        if (!tab?.id) return null;
        const from = msg.from === 'top' ? tab.id : tab.openerTabId;
        if (from === undefined) return null;
        const s = await getTab(from);
        return s ? { status: s.status, reason: s.reason ?? '' } : null;
      }
      case 'relatedFailed': {
        const tab = sender.tab;
        if (!tab?.id) return;
        // A failing subframe fails its own tab; a failing opened window fails its opener.
        const target = sender.frameId !== 0 ? tab.id : tab.openerTabId;
        if (target === undefined) return;
        await chrome.tabs.sendMessage(target, { type: 'relatedFailed', reason: msg.reason } satisfies RelatedFailedMsg, { frameId: 0 }).catch(() => {});
        return;
      }
      case 'getStatus':
        return getTab(msg.tabId);
      case 'getPin':
        return (await getPins())[msg.host] ?? null;
      case 'setPin': {
        const pins = await getPins();
        if (msg.pin) pins[msg.host] = msg.pin;
        else delete pins[msg.host];
        await chrome.storage.local.set({ pins });
        return true;
      }
      case 'getSettings':
        return getSettings();
      case 'setSettings':
        await chrome.storage.local.set({ settings: msg.settings });
        return true;
    }
  })().then(respond, (e) => respond({ error: String(e) }));
  return true;
});

chrome.tabs.onRemoved.addListener((id) => {
  chrome.storage.session.remove(tabKey(id)).catch(() => {});
});
