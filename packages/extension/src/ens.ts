import { createPublicClient, fallback, http } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { normalize } from 'viem/ens';
import { RECORD_KEY, parseRecord } from '@webseal/core';
import { RPCS, type Settings } from './types.ts';

const cache = new Map<string, { at: number; value: string | null }>();
const TTL = 60_000;

export interface RecordLookup {
  hash?: string;
  /** Every accepted manifest hash (two during a rollout). */
  hashes?: string[];
  raw: string | null;
  error?: string;
  /** The lookup succeeded and neither the name nor webseal.<name> has a record. */
  notFound?: boolean;
}

export async function resolveRecord(name: string, settings: Settings, fresh = false): Promise<RecordLookup> {
  const chain = settings.chain === 'mainnet' ? mainnet : sepolia;
  // A custom RPC is used alone (the user chose to trust it); otherwise the public ones, in order.
  const rpcs = settings.rpc ? [settings.rpc] : RPCS[settings.chain];
  const key = `${settings.chain}|${rpcs.join(',')}|${name}`;
  const hit = cache.get(key);
  let raw: string | null;
  try {
    if (!fresh && hit && Date.now() - hit.at < TTL) raw = hit.value;
    else {
      const transport = rpcs.length === 1 ? http(rpcs[0]) : fallback(rpcs.map((u) => http(u, { timeout: 8_000, retryCount: 1 })));
      const client = createPublicClient({ chain, transport });
      const ens = normalize(name);
      raw = await client.getEnsText({ name: ens, key: RECORD_KEY });
      if (!raw) raw = await client.getEnsText({ name: normalize(`${RECORD_KEY}.${ens}`), key: RECORD_KEY });
      cache.set(key, { at: Date.now(), value: raw });
    }
  } catch (e) {
    return { raw: null, error: `ENS lookup for ${name} failed: ${(e as Error).message.split('\n')[0]}` };
  }
  const parsed = parseRecord(raw);
  if (!parsed) {
    return raw
      ? { raw, error: 'record is not a webseal v1 value' }
      : { raw, error: `no "${RECORD_KEY}" text record on ${name}`, notFound: true };
  }
  return { hash: parsed.hash, hashes: parsed.hashes, raw };
}
