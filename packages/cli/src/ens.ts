import { createPublicClient, createWalletClient, fallback, http, namehash, type Chain, type Hex, type Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia } from 'viem/chains';
import { normalize } from 'viem/ens';
import { RECORD_KEY } from '@webseal/core';

/** Public RPCs, tried in order for reads when --rpc is not given (same list as the extension). */
export const CHAINS: Record<string, { chain: Chain; rpcs: string[] }> = {
  mainnet: { chain: mainnet, rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'] },
  sepolia: { chain: sepolia, rpcs: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://1rpc.io/sepolia'] },
};

export function pickChain(name: string | undefined, rpc?: string) {
  const entry = CHAINS[name ?? 'mainnet'];
  if (!entry) throw new Error(`unknown chain "${name}". Use one of: ${Object.keys(CHAINS).join(', ')}`);
  const rpcs = rpc ? [rpc] : entry.rpcs;
  // Reads may fall back to the next RPC; transactions go to the first one only.
  const read: Transport = rpcs.length === 1 ? http(rpcs[0]) : fallback(rpcs.map((u) => http(u, { timeout: 10_000, retryCount: 1 })));
  return { chain: entry.chain, rpc: rpcs[0], read };
}

const resolverAbi = [
  {
    type: 'function',
    name: 'setText',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
      { name: 'value', type: 'string' },
    ],
    outputs: [],
  },
] as const;

export async function readRecord(name: string, chainName: string | undefined, rpc?: string) {
  const { chain, read } = pickChain(chainName, rpc);
  const client = createPublicClient({ chain, transport: read });
  const ens = normalize(name);
  const value = await client.getEnsText({ name: ens, key: RECORD_KEY });
  return { chain: chain.name, name: ens, value };
}

/**
 * Read the record the way the extension does: on the name itself, then on
 * webseal.<name> (the subname a limited-rights CI key can own).
 */
export async function readRecordWithFallback(name: string, chainName: string | undefined, rpc?: string) {
  const own = await readRecord(name, chainName, rpc);
  if (own.value) return { ...own, from: own.name };
  const sub = await readRecord(`${RECORD_KEY}.${own.name}`, chainName, rpc);
  return { ...sub, name: own.name, from: sub.value ? sub.name : own.name };
}

export async function writeRecord(opts: {
  name: string;
  value: string;
  chainName?: string;
  rpc?: string;
  privateKey: Hex;
}) {
  const { chain, rpc, read } = pickChain(opts.chainName, opts.rpc);
  const account = privateKeyToAccount(opts.privateKey);
  const publicClient = createPublicClient({ chain, transport: read });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  const ens = normalize(opts.name);
  const resolver = await publicClient.getEnsResolver({ name: ens });
  if (!resolver || /^0x0{40}$/i.test(resolver)) throw new Error(`${ens} has no resolver set; set one in the ENS app first`);
  const hash = await wallet.writeContract({
    address: resolver,
    abi: resolverAbi,
    functionName: 'setText',
    args: [namehash(ens), RECORD_KEY, opts.value],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { tx: hash, resolver, status: receipt.status, from: account.address, chain: chain.name };
}
