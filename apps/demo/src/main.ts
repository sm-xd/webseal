import { BaseError, createWalletClient, custom, parseEther, type Address, type EIP1193Provider } from 'viem';
import { sepolia } from 'viem/chains';

// The address the transaction actually goes to. The tamper script changes
// this constant and nothing else, so the page still *displays* the right
// address while *sending* to the attacker. That is the Bybit shape.
const TREASURY: Address = '0x1111111111111111111111111111111111111111';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = (line: string) => {
  const el = $('log');
  el.textContent = `${new Date().toLocaleTimeString()}  ${line}\n` + el.textContent;
};

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

let account: Address | undefined;

// viem replaces a provider error's message with a generic one per error code (4100 becomes
// "not authorized by the user"); show the wallet's (or WebSeal's) own message instead.
function reason(e: unknown): string {
  if (e instanceof BaseError) {
    const root = e.walk();
    return root instanceof Error && root.message ? root.message.split(/\r?\n/)[0] : e.shortMessage;
  }
  return (e as Error).message;
}

function provider(): EIP1193Provider {
  if (!window.ethereum) throw new Error('no wallet found: install MetaMask or another EIP-1193 wallet');
  return window.ethereum;
}

// The demo only ever sends on Sepolia. Ask the wallet to switch (and add the
// chain if it does not know it) so a wallet left on mainnet never gets a real
// 0.01 ETH prompt.
async function ensureSepolia() {
  const client = createWalletClient({ chain: sepolia, transport: custom(provider()) });
  const current = await client.getChainId();
  if (current === sepolia.id) return;
  log(`wallet is on chain ${current}, asking it to switch to Sepolia...`);
  try {
    await client.switchChain({ id: sepolia.id });
  } catch (e) {
    const code = (e as { code?: number; cause?: { code?: number } }).code ?? (e as { cause?: { code?: number } }).cause?.code;
    if (code !== 4902) throw e;
    await client.addChain({ chain: sepolia });
  }
  log('switched to Sepolia');
}

$('connect').addEventListener('click', async () => {
  try {
    const client = createWalletClient({ chain: sepolia, transport: custom(provider()) });
    [account] = await client.requestAddresses();
    $('account').textContent = account;
    await ensureSepolia();
    $<HTMLButtonElement>('send').disabled = false;
    $<HTMLButtonElement>('sign').disabled = false;
    log(`connected ${account}`);
  } catch (e) {
    log(`connect failed: ${reason(e)}`);
  }
});

$('send').addEventListener('click', async () => {
  try {
    await ensureSepolia();
    const client = createWalletClient({ account, chain: sepolia, transport: custom(provider()) });
    log(`sending 0.01 ETH to ${TREASURY} ...`);
    const hash = await client.sendTransaction({ account: account!, to: TREASURY, value: parseEther('0.01') });
    log(`sent: ${hash}`);
  } catch (e) {
    log(`send failed: ${reason(e)}`);
  }
});

$('sign').addEventListener('click', async () => {
  try {
    const client = createWalletClient({ account, chain: sepolia, transport: custom(provider()) });
    const sig = await client.signMessage({ account: account!, message: `Sign in to Acme Treasury at ${new Date().toISOString()}` });
    log(`signature: ${sig.slice(0, 20)}...`);
  } catch (e) {
    log(`sign failed: ${reason(e)}`);
  }
});
