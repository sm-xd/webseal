/**
 * ENSv2 Permissioned Resolver: the part of its interface WebSeal uses.
 *
 * Taken from the verified source of the live implementation
 * (mainnet 0x565b0f456a04ac9b48758190e90030623cff57c5, Sepolia
 * 0x115eb53f0c60696633855f90b138178fb40b2b2c; identical ABIs). In ENSv2 every
 * account has its own resolver, records are written with the DNS-encoded name,
 * and roles can be granted for a single record key: that is what lets a CI key
 * update the `webseal` record and nothing else.
 */
export const PERMISSIONED_RESOLVER_ABI = [
  {
    type: 'function',
    name: 'setText',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'name', type: 'bytes' },
      { name: 'key', type: 'string' },
      { name: 'value', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'grantSetterRoles',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'setter', type: 'bytes' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'revokeRoles',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'resource', type: 'uint256' },
      { name: 'roleBitmap', type: 'uint256' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'linkToNode',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sourceName', type: 'bytes' },
      { name: 'targetNode', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'decodeSetter',
    stateMutability: 'pure',
    inputs: [{ name: 'setter', type: 'bytes' }],
    outputs: [{ type: 'bytes' }, { type: 'uint256' }, { type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'hasRoles',
    stateMutability: 'view',
    inputs: [
      { name: 'resource', type: 'uint256' },
      { name: 'roleBitmap', type: 'uint256' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getAssigneeCount',
    stateMutability: 'view',
    inputs: [
      { name: 'resource', type: 'uint256' },
      { name: 'roleBitmap', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }],
  },
  { type: 'function', name: 'getRecordCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'getRecordId',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'EACRolesChanged',
    inputs: [
      { name: 'resource', type: 'uint256', indexed: true },
      { name: 'account', type: 'address', indexed: true },
      { name: 'oldRoleBitmap', type: 'uint256', indexed: false },
      { name: 'newRoleBitmap', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** Role bit for text records (one nybble per role; admin roles sit 128 bits higher). */
export const ROLE_SET_TEXT = 1n << 4n;
/** Roles on resource 0 apply to every record the resolver serves. */
export const ROOT_RESOURCE = 0n;

/**
 * getAssigneeCount returns a counter bitmap with one 4-bit count per role.
 * Returns how many accounts hold `roleBit` (a single role) on that resource.
 */
export function assigneeCount(counts: bigint, roleBit: bigint): number {
  if (roleBit <= 0n || (roleBit & (roleBit - 1n)) !== 0n) throw new Error('roleBit must be a single bit');
  return Number((counts / roleBit) & 0xfn);
}

/** Who can change a name's `webseal` record, as shown in the popup and by `webseal writers`. */
export interface RecordWriters {
  /** The name's resolver is an ENSv2 Permissioned Resolver. */
  v2: boolean;
  resolver: string;
  /** Accounts that may set any text record on every name this resolver serves (normally only the owner). */
  allRecords: number;
  /** Accounts granted only the `webseal` text record (for example a CI key). */
  thisRecordOnly: number;
}
