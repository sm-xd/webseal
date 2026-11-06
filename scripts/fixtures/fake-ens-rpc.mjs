// Test-only JSON-RPC server that answers ENS text-record lookups the way the
// ENS Universal Resolver does, from an in-memory map. Lets the e2e suites
// exercise the real viem lookup path (name, webseal.<name> fallback, rollout
// records) without a chain, a key or network access.
//
//   const ens = await startFakeEns({ port: 8599, records: { 'app.eth': 'v1:sha256:…' } });
//   ens.set('webseal.app.eth', 'v1:sha256:…');  ens.close();
//
// Records are keyed by name; every lookup is for the `webseal` text key.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';

// viem is a dependency of the workspace packages, not of the repo root.
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../../packages/cli/package.json'));
const { decodeFunctionData, encodeFunctionResult, hexToBytes, parseAbi, keccak256, toHex } = require('viem');

const abi = parseAbi([
  'function resolveWithGateways(bytes name, bytes data, string[] gateways) view returns (bytes, address)',
  'function findResolver(bytes name) view returns (address, bytes32, uint256)',
  'function text(bytes32 node, string key) view returns (string)',
  // ENSv2 Permissioned Resolver views used to show who can change a record
  'function getRecordCount() view returns (uint256)',
  'function decodeSetter(bytes setter) pure returns (bytes, uint256, uint256)',
  'function getAssigneeCount(uint256 resource, uint256 roleBitmap) view returns (uint256, uint256)',
]);
const RESOLVER = '0x000000000000000000000000000000000000beef'; // an ENSv1-style resolver: no ENSv2 views
const ROLE_SET_TEXT = 16n;
const WEBSEAL_RESOURCE = BigInt(keccak256(toHex('webseal')));
const resolverOf = (name) => '0x' + keccak256(toHex(name)).slice(-40); // one fake ENSv2 resolver per configured name

/** DNS wire format (3app3eth0) -> "app.eth" */
function dnsDecode(hex) {
  const b = hexToBytes(hex);
  const labels = [];
  for (let i = 0; i < b.length && b[i] !== 0; i += b[i] + 1) labels.push(new TextDecoder().decode(b.slice(i + 1, i + 1 + b[i])));
  return labels.join('.');
}

/**
 * records: { name: textValue }   writers: { name: { all, only } } makes that name's
 * resolver an ENSv2 Permissioned Resolver with `all` full-control accounts and
 * `only` accounts limited to the webseal record.
 */
export async function startFakeEns({ port, records = {}, writers = {}, chainId = 11155111 }) {
  const map = new Map(Object.entries(records));
  const v2 = new Map(Object.entries(writers).map(([n, w]) => [resolverOf(n).toLowerCase(), w]));
  const calls = [];
  const answer = (m) => {
    if (m.method === 'eth_chainId') return '0x' + chainId.toString(16);
    if (m.method === 'eth_blockNumber') return '0x1';
    if (m.method !== 'eth_call') throw Object.assign(new Error(`unsupported ${m.method}`), { code: -32601 });
    const to = String(m.params[0].to).toLowerCase();
    const { functionName, args } = decodeFunctionData({ abi, data: m.params[0].data ?? m.params[0].input });
    if (functionName === 'findResolver') {
      const name = dnsDecode(args[0]);
      return encodeFunctionResult({ abi, functionName, result: [writers[name] ? resolverOf(name) : RESOLVER, '0x' + '00'.repeat(32), 0n] });
    }
    if (functionName === 'getRecordCount' || functionName === 'decodeSetter' || functionName === 'getAssigneeCount') {
      const w = v2.get(to);
      if (!w) throw new Error('execution reverted'); // ENSv1 resolver: no such function
      if (functionName === 'getRecordCount') return encodeFunctionResult({ abi, functionName, result: 1n });
      if (functionName === 'decodeSetter') return encodeFunctionResult({ abi, functionName, result: ['0x', WEBSEAL_RESOURCE, ROLE_SET_TEXT] });
      const n = args[0] === 0n ? w.all : w.only;
      return encodeFunctionResult({ abi, functionName, result: [BigInt(n) * ROLE_SET_TEXT, 0xf0n] });
    }
    if (functionName !== 'resolveWithGateways') throw new Error('unexpected call');
    const name = dnsDecode(args[0]);
    calls.push(name);
    const value = map.get(name);
    const inner = value === undefined ? '0x' : encodeFunctionResult({ abi, functionName: 'text', result: value });
    return encodeFunctionResult({ abi, functionName: 'resolveWithGateways', result: [inner, RESOLVER] });
  };
  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }).end();
      return;
    }
    let body = '';
    for await (const c of req) body += c;
    const msg = JSON.parse(body);
    const one = (m) => {
      try {
        return { jsonrpc: '2.0', id: m.id, result: answer(m) };
      } catch (e) {
        return { jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32000, message: e.message } };
      }
    };
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
    res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
  });
  await new Promise((r) => server.listen(port, r));
  return {
    url: `http://localhost:${port}`,
    calls,
    set: (name, value) => (value === undefined ? map.delete(name) : map.set(name, value)),
    close: () => new Promise((r) => server.close(r)),
  };
}

// Run as a separate process (the e2e scripts block their own event loop on CLI calls):
//   node scripts/fixtures/fake-ens-rpc.mjs <port> '<json records>' ['<json writers>']
// Prints "ready" once listening. POST {name, value} to the control port changes a record.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8599);
  const ens = await startFakeEns({ port: port + 1, records: JSON.parse(process.argv[3] ?? '{}'), writers: JSON.parse(process.argv[4] ?? '{}') });
  // Control endpoint on `port`, RPC on `port + 1`.
  createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const { name, value } = JSON.parse(body || '{}');
    ens.set(name, value);
    res.end('ok');
  }).listen(port, () => console.log(`ready rpc=${ens.url}`));
}
