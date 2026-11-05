import { createPublicClient, http } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { normalize } from 'viem/ens';
import { RECORD_KEY, parseRecord } from '@webseal/core';
import { RPCS, type Settings } from './types.ts';

const cache = new Map<string, { at: number; value: string | null }>();
const TTL = 60_000;

export async function resolveRecord(name: string, settings: Settings): Promise<{ hash?: string; raw: string | null; error?: string }> {
  const chain = settings.chain === 'mainnet' ? mainnet : sepolia;
  const rpc = settings.rpc || RPCS[settings.chain];
  const key = `${settings.chain}|${rpc}|${name}`;
  const hit = cache.get(key);
  let raw: string | null;
  try {
    if (hit && Date.now() - hit.at < TTL) raw = hit.value;
    else {
      const client = createPublicClient({ chain, transport: http(rpc) });
      const ens = normalize(name);
      raw = await client.getEnsText({ name: ens, key: RECORD_KEY });
      if (!raw) raw = await client.getEnsText({ name: normalize(`${RECORD_KEY}.${ens}`), key: RECORD_KEY });
      cache.set(key, { at: Date.now(), value: raw });
    }
  } catch (e) {
    return { raw: null, error: `ENS lookup failed: ${(e as Error).message.split('\n')[0]}` };
  }
  const parsed = parseRecord(raw);
  if (!parsed) return { raw, error: raw ? 'record is not a webseal v1 value' : `no "${RECORD_KEY}" text record on ${name}` };
  return { hash: parsed.hash, raw };
}
