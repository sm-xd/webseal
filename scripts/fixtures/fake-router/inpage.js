// Test-only extension that behaves like Flow Wallet's router: it takes over
// window.ethereum with a locked (non-configurable) accessor, keeps whatever
// provider a wallet assigns, and hands pages a proxy that forwards to it.
// WebSeal cannot wrap window.ethereum here, so it must guard the provider itself.
(() => {
  let current = window.ethereum;
  window.fakeRouter = { get current() { return current; } };
  try {
    Object.defineProperty(window, 'ethereum', {
      configurable: false,
      enumerable: true,
      get() {
        return current ? new Proxy(current, { get: (t, k) => t[k] }) : undefined;
      },
      set(v) {
        current = v;
      },
    });
  } catch (e) {
    window.fakeRouter.error = String(e);
  }
})();
