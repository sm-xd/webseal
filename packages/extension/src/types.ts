import type { VerifyReport } from '@webseal/core';
import type { PageStatus } from './channel.ts';

export type { PageStatus };

export type Pin = { kind: 'ens'; name: string } | { kind: 'hash'; hash: string };

export type Anchor =
  | { kind: 'none'; note?: string }
  | { kind: 'hash'; hash: string }
  | { kind: 'ens'; name: string; chain: string; hash?: string; hashes?: string[]; error?: string; derived?: boolean };

export interface Settings {
  chain: 'mainnet' | 'sepolia';
  rpc?: string;
}

/** Where a frame or window takes its verdict from when page code elsewhere could reach its wallet. */
export type InheritFrom = 'top' | 'opener';

export type Msg =
  | { type: 'anchor'; host: string; fresh?: boolean }
  | { type: 'report'; report: VerifyReport | undefined; status: PageStatus; reason?: string }
  | { type: 'getStatus'; tabId: number }
  | { type: 'getInherited'; from: InheritFrom }
  | { type: 'getPin'; host: string }
  | { type: 'setPin'; host: string; pin: Pin | null }
  | { type: 'getSettings' }
  | { type: 'setSettings'; settings: Settings }
  | { type: 'relatedFailed'; reason: string }
  | { type: 'recheck' };

/** Forwarded by the service worker to the top frame of the tab that a failing frame or window can reach. */
export interface RelatedFailedMsg {
  type: 'relatedFailed';
  reason: string;
}

/** Sent by the service worker to content scripts when a verdict they inherit changes. */
export interface InheritedMsg {
  type: 'inherited';
  from: InheritFrom;
  status: PageStatus;
  reason: string;
}

export interface TabState {
  status: PageStatus;
  reason?: string;
  report?: VerifyReport;
  host: string;
  url: string;
}

export const DEFAULT_SETTINGS: Settings = { chain: 'sepolia' };
/** Public RPCs, tried in order (viem fallback transport) when no custom RPC is set. */
export const RPCS: Record<Settings['chain'], string[]> = {
  mainnet: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'],
  sepolia: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://1rpc.io/sepolia'],
};
