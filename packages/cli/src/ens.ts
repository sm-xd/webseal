import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback,
  formatEther,
  formatGwei,
  http,
  namehash,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia } from 'viem/chains';
import { normalize, packetToBytes } from 'viem/ens';
import { PERMISSIONED_RESOLVER_ABI, RECORD_KEY, ROLE_SET_TEXT, ROOT_RESOURCE, assigneeCount, type RecordWriters } from '@webseal/core';

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

/** ENSv1 resolvers take the namehash; ENSv2 Permissioned Resolvers take the DNS-encoded name. */
const V1_RESOLVER_ABI = [
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
const ROLES_ABI = [
  {
    type: 'function',
    name: 'roles',
    stateMutability: 'view',
    inputs: [
      { name: 'resource', type: 'uint256' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const dnsEncode = (name: string) => toHex(packetToBytes(name));
const isZero = (a?: string | null) => !a || /^0x0{40}$/i.test(a);

/** Who signs: a private key sends the transaction; an address only simulates it (dry run, no key needed). */
export type Signer = { privateKey: Hex } | { as: Address };

export interface TxResult {
  simulated: boolean;
  from: Address;
  resolver: Address;
  gas: bigint;
  /** Fee in wei: estimated for a dry run, actual once mined. */
  fee: bigint;
  gasPrice: bigint;
  tx?: Hex;
  status?: string;
}

export function describeFee(r: TxResult): string {
  return `${Number(formatEther(r.fee)).toPrecision(3)} ETH (${r.gas} gas at ${Number(formatGwei(r.gasPrice)).toPrecision(3)} gwei)`;
}

async function nameContext(name: string, chainName: string | undefined, rpc?: string) {
  const { chain, rpc: url, read } = pickChain(chainName, rpc);
  const client = createPublicClient({ chain, transport: read }) as PublicClient;
  const ens = normalize(name);
  const resolver = await client.getEnsResolver({ name: ens });
  if (isZero(resolver)) throw new Error(`${ens} has no resolver on ${chain.name}; set one in the ENS app first`);
  // getRecordCount exists only on ENSv2 Permissioned Resolvers.
  const v2 = await client
    .readContract({ address: resolver, abi: PERMISSIONED_RESOLVER_ABI, functionName: 'getRecordCount' })
    .then(() => true, () => false);
  return { chain, url, client, ens, resolver, v2 };
}

/** Simulate a resolver call as the signer; send it when the signer has a key. */
async function execute(
  ctx: Awaited<ReturnType<typeof nameContext>>,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
  signer: Signer,
  what: string,
): Promise<TxResult> {
  const account = 'privateKey' in signer ? privateKeyToAccount(signer.privateKey) : undefined;
  const from = account ? account.address : (signer as { as: Address }).as;
  const call = { address: ctx.resolver, abi: abi as typeof PERMISSIONED_RESOLVER_ABI, functionName: functionName as 'setText', args: args as never };
  let gas: bigint;
  try {
    gas = await ctx.client.estimateContractGas({ ...call, account: from });
  } catch (e) {
    const why = (e as { shortMessage?: string }).shortMessage ?? String(e);
    throw new Error(`${from} cannot ${what} on ${ctx.ens} (${ctx.chain.name}): the transaction would revert. Is this the owner, or an account granted this record? [${why.split('\n')[0]}]`);
  }
  const gasPrice = await ctx.client.getGasPrice();
  if (!account) return { simulated: true, from, resolver: ctx.resolver, gas, gasPrice, fee: gas * gasPrice };
  const wallet = createWalletClient({ account, chain: ctx.chain, transport: http(ctx.url) });
  const tx = await wallet.writeContract({ ...call, gas: (gas * 12n) / 10n } as never);
  const receipt = await ctx.client.waitForTransactionReceipt({ hash: tx });
  return {
    simulated: false,
    from,
    resolver: ctx.resolver,
    gas: receipt.gasUsed,
    gasPrice: receipt.effectiveGasPrice,
    fee: receipt.gasUsed * receipt.effectiveGasPrice,
    tx,
    status: receipt.status,
  };
}

/* ---------- reading ---------- */

export async function readRecord(name: string, chainName: string | undefined, rpc?: string) {
  const { chain, read } = pickChain(chainName, rpc);
  const client = createPublicClient({ chain, transport: read });
  const ens = normalize(name);
  const value = await client.getEnsText({ name: ens, key: RECORD_KEY });
  return { chain: chain.name, name: ens, value };
}

/**
 * Read the record the way the extension does: on the name itself, then on
 * webseal.<name> (the subname pattern from ENSv1; on ENSv2 a per-record grant does the same job).
 */
export async function readRecordWithFallback(name: string, chainName: string | undefined, rpc?: string) {
  const own = await readRecord(name, chainName, rpc);
  if (own.value) return { ...own, from: own.name };
  const sub = await readRecord(`${RECORD_KEY}.${own.name}`, chainName, rpc);
  return { ...sub, name: own.name, from: sub.value ? sub.name : own.name };
}

/** The resource id a resolver uses for one text key (where per-key grants live). */
async function textResource(ctx: Awaited<ReturnType<typeof nameContext>>, key: string): Promise<bigint> {
  const setter = encodeFunctionData({ abi: PERMISSIONED_RESOLVER_ABI, functionName: 'setText', args: ['0x', key, ''] });
  const [, resource] = await ctx.client.readContract({ address: ctx.resolver, abi: PERMISSIONED_RESOLVER_ABI, functionName: 'decodeSetter', args: [setter] });
  return resource;
}

/**
 * Who can change the record: counts from the resolver, and (best effort) the
 * addresses from its role-change events.
 */
export async function recordWriters(name: string, chainName: string | undefined, rpc?: string, key = RECORD_KEY, check: Address[] = []) {
  const ctx = await nameContext(name, chainName, rpc);
  const base: RecordWriters = { v2: ctx.v2, resolver: ctx.resolver, allRecords: 0, thisRecordOnly: 0 };
  if (!ctx.v2) return { ...base, name: ctx.ens, chain: ctx.chain.name, accounts: [] as { address: Address; scope: string }[], complete: true, checks: [] as { address: Address; can: boolean }[] };
  const resource = await textResource(ctx, key);
  const count = async (r: bigint) =>
    assigneeCount((await ctx.client.readContract({ address: ctx.resolver, abi: PERMISSIONED_RESOLVER_ABI, functionName: 'getAssigneeCount', args: [r, ROLE_SET_TEXT] }))[0], ROLE_SET_TEXT);
  base.allRecords = await count(ROOT_RESOURCE);
  base.thisRecordOnly = await count(resource);

  // Addresses: scan role-change events for both resources, newest first, then
  // confirm each account still holds the role. Free public RPCs serve only
  // recent logs, so the scan can be incomplete; `complete` says whether it reached back far enough.
  const accounts: { address: Address; scope: string }[] = [];
  const seen = new Set<Address>();
  let complete = true;
  const STEP = 10_000n; // public RPCs cap log queries at about 10k blocks
  try {
    const latest = await ctx.client.getBlockNumber();
    for (let to = latest; to > latest - 200_000n && to > 0n; to -= STEP) {
      const logs = await ctx.client.getContractEvents({
        address: ctx.resolver,
        abi: PERMISSIONED_RESOLVER_ABI,
        eventName: 'EACRolesChanged',
        args: { resource: [ROOT_RESOURCE, resource] },
        fromBlock: to - STEP + 1n > 0n ? to - STEP + 1n : 0n,
        toBlock: to,
      });
      for (const l of logs) if (l.args.account) seen.add(l.args.account);
    }
  } catch {
    complete = false; // the RPC refused older logs
  }
  for (const a of seen) {
    const [root, own] = await Promise.all(
      [ROOT_RESOURCE, resource].map((r) => ctx.client.readContract({ address: ctx.resolver, abi: ROLES_ABI, functionName: 'roles', args: [r, a] })),
    );
    if (root & ROLE_SET_TEXT) accounts.push({ address: a, scope: 'every record on this resolver' });
    else if (own & ROLE_SET_TEXT) accounts.push({ address: a, scope: `only the "${key}" record` });
  }
  if (accounts.length < base.allRecords + base.thisRecordOnly) complete = false;
  const checks = await Promise.all(
    check.map(async (address) => ({
      address,
      can: await ctx.client.readContract({ address: ctx.resolver, abi: PERMISSIONED_RESOLVER_ABI, functionName: 'hasRoles', args: [resource, ROLE_SET_TEXT, address] }),
    })),
  );
  return { ...base, name: ctx.ens, chain: ctx.chain.name, accounts, complete, checks };
}

/* ---------- writing ---------- */

export async function writeRecord(opts: { name: string; value: string; chainName?: string; rpc?: string; signer: Signer; key?: string }) {
  const ctx = await nameContext(opts.name, opts.chainName, opts.rpc);
  const key = opts.key ?? RECORD_KEY;
  const r = ctx.v2
    ? await execute(ctx, PERMISSIONED_RESOLVER_ABI, 'setText', [dnsEncode(ctx.ens), key, opts.value], opts.signer, `set the "${key}" record`)
    : await execute(ctx, V1_RESOLVER_ABI, 'setText', [namehash(ctx.ens), key, opts.value], opts.signer, `set the "${key}" record`);
  return { ...r, v2: ctx.v2, chain: ctx.chain.name };
}

function requireV2(ctx: { v2: boolean; ens: string; resolver: string }) {
  if (!ctx.v2) throw new Error(`${ctx.ens} uses an ENSv1 resolver (${ctx.resolver}); per-record permissions need ENSv2. Use the webseal.<name> subname pattern instead.`);
}

/**
 * ENSv2: let `account` set only this text record. Note that a Permissioned
 * Resolver's grants cover every name it serves; give the app's name its own
 * resolver if the owner account also uses this resolver for other names.
 */
export async function grantRecordWriter(opts: { name: string; account: Address; chainName?: string; rpc?: string; signer: Signer; key?: string }) {
  const ctx = await nameContext(opts.name, opts.chainName, opts.rpc);
  requireV2(ctx);
  const key = opts.key ?? RECORD_KEY;
  const setter = encodeFunctionData({ abi: PERMISSIONED_RESOLVER_ABI, functionName: 'setText', args: ['0x', key, ''] });
  const r = await execute(ctx, PERMISSIONED_RESOLVER_ABI, 'grantSetterRoles', [setter, opts.account], opts.signer, `grant the "${key}" record`);
  return { ...r, chain: ctx.chain.name };
}

export async function revokeRecordWriter(opts: { name: string; account: Address; chainName?: string; rpc?: string; signer: Signer; key?: string }) {
  const ctx = await nameContext(opts.name, opts.chainName, opts.rpc);
  requireV2(ctx);
  const resource = await textResource(ctx, opts.key ?? RECORD_KEY);
  const r = await execute(ctx, PERMISSIONED_RESOLVER_ABI, 'revokeRoles', [resource, ROLE_SET_TEXT, opts.account], opts.signer, 'revoke the record');
  return { ...r, chain: ctx.chain.name };
}

/**
 * ENSv2 record linking: `source` serves the same record bundle as `target`, so
 * one publish updates both (for example beta.app.eth and app.eth). Both names
 * must use the same Permissioned Resolver.
 */
export async function linkNames(opts: { source: string; target: string; chainName?: string; rpc?: string; signer: Signer }) {
  const src = await nameContext(opts.source, opts.chainName, opts.rpc);
  requireV2(src);
  const dst = await nameContext(opts.target, opts.chainName, opts.rpc);
  if (dst.resolver.toLowerCase() !== src.resolver.toLowerCase()) {
    throw new Error(`${src.ens} and ${dst.ens} use different resolvers (${src.resolver}, ${dst.resolver}); point both names at the same resolver in the ENS app first`);
  }
  const r = await execute(src, PERMISSIONED_RESOLVER_ABI, 'linkToNode', [dnsEncode(src.ens), namehash(dst.ens)], opts.signer, `link to ${dst.ens}`);
  return { ...r, chain: src.chain.name };
}
