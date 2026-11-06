import { createPublicClient, encodeFunctionData, fallback, http, type PublicClient } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { normalize } from 'viem/ens';
import {
  PERMISSIONED_RESOLVER_ABI,
  RECORD_KEY,
  ROLE_SET_TEXT,
  ROOT_RESOURCE,
  assigneeCount,
  parseRecord,
  type RecordWriters,
} from '@webseal/core';
import { RPCS, type Settings } from './types.ts';

const cache = new Map<string, { at: number; value: string | null; from: string }>();

/**
 * ENSv2: how many accounts can change the record (anyone with the text role on
 * every record, plus accounts granted only the webseal record). Best effort:
 * undefined when the resolver is not reachable or not ENSv2-aware.
 */
async function writersOf(client: PublicClient, name: string): Promise<RecordWriters | undefined> {
  try {
    const resolver = await client.getEnsResolver({ name });
    const call = { address: resolver, abi: PERMISSIONED_RESOLVER_ABI } as const;
    const v2 = await client.readContract({ ...call, functionName: 'getRecordCount' }).then(() => true, () => false);
    if (!v2) return { v2: false, resolver, allRecords: 0, thisRecordOnly: 0 };
    const setter = encodeFunctionData({ abi: PERMISSIONED_RESOLVER_ABI, functionName: 'setText', args: ['0x', RECORD_KEY, ''] });
    const [, resource] = await client.readContract({ ...call, functionName: 'decodeSetter', args: [setter] });
    const [all] = await client.readContract({ ...call, functionName: 'getAssigneeCount', args: [ROOT_RESOURCE, ROLE_SET_TEXT] });
    const [own] = await client.readContract({ ...call, functionName: 'getAssigneeCount', args: [resource, ROLE_SET_TEXT] });
    return { v2: true, resolver, allRecords: assigneeCount(all, ROLE_SET_TEXT), thisRecordOnly: assigneeCount(own, ROLE_SET_TEXT) };
  } catch {
    return undefined;
  }
}
const TTL = 60_000;

export interface RecordLookup {
  hash?: string;
  /** Every accepted manifest hash (two during a rollout). */
  hashes?: string[];
  raw: string | null;
  error?: string;
  /** The lookup succeeded and neither the name nor webseal.<name> has a record. */
  notFound?: boolean;
  /** ENSv2: who can change the record (only when a record was found). */
  writers?: RecordWriters;
}
const writersCache = new Map<string, { at: number; value: RecordWriters | undefined }>();

export async function resolveRecord(name: string, settings: Settings, fresh = false): Promise<RecordLookup> {
  const chain = settings.chain === 'mainnet' ? mainnet : sepolia;
  // A custom RPC is used alone (the user chose to trust it); otherwise the public ones, in order.
  const rpcs = settings.rpc ? [settings.rpc] : RPCS[settings.chain];
  const key = `${settings.chain}|${rpcs.join(',')}|${name}`;
  const hit = cache.get(key);
  let raw: string | null;
  let from = name;
  const transport = rpcs.length === 1 ? http(rpcs[0]) : fallback(rpcs.map((u) => http(u, { timeout: 8_000, retryCount: 1 })));
  const client = createPublicClient({ chain, transport }) as PublicClient;
  try {
    if (!fresh && hit && Date.now() - hit.at < TTL) {
      raw = hit.value;
      from = hit.from;
    } else {
      const ens = normalize(name);
      from = ens;
      raw = await client.getEnsText({ name: ens, key: RECORD_KEY });
      if (!raw) {
        from = normalize(`${RECORD_KEY}.${ens}`);
        raw = await client.getEnsText({ name: from, key: RECORD_KEY });
      }
      cache.set(key, { at: Date.now(), value: raw, from });
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
  const wkey = `${key}|${from}`;
  const whit = writersCache.get(wkey);
  let writers = whit && !fresh && Date.now() - whit.at < TTL ? whit.value : undefined;
  if (!writers) {
    writers = await writersOf(client, from);
    writersCache.set(wkey, { at: Date.now(), value: writers });
  }
  return { hash: parsed.hash, hashes: parsed.hashes, raw, writers };
}
