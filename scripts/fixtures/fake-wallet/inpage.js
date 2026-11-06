// Test-only wallet extension: injects an EIP-1193 provider into every frame the way
// MetaMask-style wallets do (MAIN world, document_start, all frames incl. about:blank),
// and announces it over EIP-6963. Used by scripts/e2e-browser.mjs.
(() => {
  const calls = [];
  window.__extWalletCalls = calls;
  // Plausible answers so a real dApp (viem) runs its whole flow. No keys, nothing is sent anywhere.
  const ACCOUNT = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
  const answers = {
    eth_chainId: '0xaa36a7', // Sepolia
    net_version: '11155111',
    eth_accounts: [ACCOUNT],
    eth_requestAccounts: [ACCOUNT],
    wallet_switchEthereumChain: null,
    eth_sendTransaction: '0x' + 'ab'.repeat(32),
    personal_sign: '0x' + '11'.repeat(65),
  };
  const provider = {
    isExtWallet: true,
    request: async ({ method }) => {
      calls.push(method);
      window.dispatchEvent(new CustomEvent('testwallet:request', { detail: method }));
      return method in answers ? answers[method] : null;
    },
    on() { return provider; },
    removeListener() { return provider; },
  };
  window.ethereum = provider;
  // Like many wallets, also expose the provider under vendor names.
  window.coinbaseWalletExtension = provider;
  window.phantom = { ethereum: provider, solana: {} };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'x', name: 'Fake', icon: 'data:,', rdns: 'test.fake' }, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();
