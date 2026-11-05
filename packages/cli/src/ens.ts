import { createPublicClient, createWalletClient, http, namehash, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia } from 'viem/chains';
import { normalize } from 'viem/ens';
import { RECORD_KEY } from '@webseal/core';

export const CHAINS: Record<string, { chain: Chain; rpc: string }> = {
  mainnet: { chain: mainnet, rpc: 'https://ethereum-rpc.publicnode.com' },
  sepolia: { chain: sepolia, rpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
};

export function pickChain(name: string | undefined, rpc?: string) {
  const entry = CHAINS[name ?? 'mainnet'];
  if (!entry) throw new Error(`unknown chain "${name}". Use one of: ${Object.keys(CHAINS).join(', ')}`);
  return { chain: entry.chain, rpc: rpc ?? entry.rpc };
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
  const { chain, rpc: url } = pickChain(chainName, rpc);
  const client = createPublicClient({ chain, transport: http(url) });
  const ens = normalize(name);
  const value = await client.getEnsText({ name: ens, key: RECORD_KEY });
  return { chain: chain.name, name: ens, value };
}

export async function writeRecord(opts: {
  name: string;
  value: string;
  chainName?: string;
  rpc?: string;
  privateKey: Hex;
}) {
  const { chain, rpc } = pickChain(opts.chainName, opts.rpc);
  const account = privateKeyToAccount(opts.privateKey);
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  const ens = normalize(opts.name);
  const resolver = await publicClient.getEnsResolver({ name: ens });
  const hash = await wallet.writeContract({
    address: resolver,
    abi: resolverAbi,
    functionName: 'setText',
    args: [namehash(ens), RECORD_KEY, opts.value],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { tx: hash, resolver, status: receipt.status, from: account.address, chain: chain.name };
}
