import { deriveNameFromHost } from '@webseal/core';
import { resolveRecord } from './ens.ts';
import { DEFAULT_SETTINGS, type Anchor, type Msg, type Pin, type Settings, type TabState } from './types.ts';

const tabs = new Map<number, TabState>();

async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}
async function getPins(): Promise<Record<string, Pin>> {
  const { pins } = await chrome.storage.local.get('pins');
  return (pins ?? {}) as Record<string, Pin>;
}

async function anchorFor(host: string): Promise<Anchor> {
  const pins = await getPins();
  const pin = pins[host];
  const settings = await getSettings();
  if (pin?.kind === 'hash') return { kind: 'hash', hash: pin.hash };
  const name = pin?.kind === 'ens' ? pin.name : deriveNameFromHost(host);
  if (!name) return { kind: 'none' };
  const r = await resolveRecord(name, settings);
  return { kind: 'ens', name, chain: settings.chain, hash: r.hash, error: r.error, derived: !pin };
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

chrome.runtime.onMessage.addListener((msg: Msg, sender, respond) => {
  (async () => {
    switch (msg.type) {
      case 'anchor':
        return anchorFor(msg.host);
      case 'report': {
        const tabId = sender.tab?.id;
        if (tabId === undefined || sender.frameId !== 0) return;
        const state: TabState = { status: msg.status, report: msg.report, host: new URL(sender.url ?? sender.tab?.url ?? 'http://x').host, url: sender.url ?? '' };
        tabs.set(tabId, state);
        badge(tabId, state);
        return;
      }
      case 'getStatus':
        return tabs.get(msg.tabId) ?? null;
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

chrome.tabs.onRemoved.addListener((id) => tabs.delete(id));
