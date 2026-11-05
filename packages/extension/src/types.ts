import type { VerifyReport } from '@webseal/core';

export type Pin = { kind: 'ens'; name: string } | { kind: 'hash'; hash: string };

export type Anchor =
  | { kind: 'none' }
  | { kind: 'hash'; hash: string }
  | { kind: 'ens'; name: string; chain: string; hash?: string; error?: string; derived?: boolean };

export interface Settings {
  chain: 'mainnet' | 'sepolia';
  rpc?: string;
}

export type PageStatus = 'pending' | 'unknown' | 'ok' | 'fail';

export type Msg =
  | { type: 'anchor'; host: string }
  | { type: 'report'; report: VerifyReport; status: PageStatus }
  | { type: 'getStatus'; tabId: number }
  | { type: 'getPin'; host: string }
  | { type: 'setPin'; host: string; pin: Pin | null }
  | { type: 'getSettings' }
  | { type: 'setSettings'; settings: Settings }
  | { type: 'recheck' };

export interface TabState {
  status: PageStatus;
  report?: VerifyReport;
  host: string;
  url: string;
}

export const DEFAULT_SETTINGS: Settings = { chain: 'sepolia' };
export const RPCS: Record<Settings['chain'], string> = {
  mainnet: 'https://ethereum-rpc.publicnode.com',
  sepolia: 'https://ethereum-sepolia-rpc.publicnode.com',
};
