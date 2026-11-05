/**
 * Runs in the page's own JavaScript world at document_start, before any page
 * script. It wraps the wallet provider so that signing methods wait for the
 * verifier's verdict and are refused when the page failed verification.
 *
 * Trust: the verifier (isolated world) proves each status message with a key
 * derived from a one-time token that only the two extension scripts ever see.
 * The token is handed over through a DOM attribute that the isolated script
 * reads and deletes synchronously, before the first page script can run.
 * Status messages are a hash chain, so a page that watches one message cannot
 * forge or replay the next.
 */
import { SIGNING_METHODS } from '@webseal/core';

type Status = 'pending' | 'unknown' | 'ok' | 'fail';

(() => {
  if (typeof crypto === 'undefined' || !crypto.subtle) return; // insecure context, nothing we can do
  const token = crypto.randomUUID() + crypto.randomUUID();
  document.documentElement.setAttribute('data-webseal-token', token);

  let status: Status = 'pending';
  let reason = '';
  let seq = 0;
  const waiters: Array<() => void> = [];
  const te = new TextEncoder();
  const sha = async (s: string) => {
    const d = await crypto.subtle.digest('SHA-256', te.encode(s));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  };

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.type !== 'webseal:status') return;
    if (d.seq !== seq) return;
    if (d.key !== (await sha(`${token}:${d.seq}`))) return;
    seq++;
    status = d.status;
    reason = typeof d.reason === 'string' ? d.reason : '';
    waiters.splice(0).forEach((f) => f());
  });

  const blockedError = () => {
    const e = new Error(
      `WebSeal blocked this request: the page's code does not match the build its publisher anchored on ENS.` +
        (reason ? ` ${reason}` : ''),
    ) as Error & { code: number };
    e.code = 4100;
    return e;
  };
  const timeoutError = () => {
    const e = new Error('WebSeal blocked this request: verification did not complete.') as Error & { code: number };
    e.code = 4100;
    return e;
  };

  const gate = (method: unknown): Promise<void> => {
    if (typeof method !== 'string' || !SIGNING_METHODS.includes(method)) return Promise.resolve();
    if (status === 'ok' || status === 'unknown') return Promise.resolve();
    if (status === 'fail') return Promise.reject(blockedError());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(timeoutError()), 20000);
      waiters.push(() => {
        clearTimeout(t);
        status === 'fail' ? reject(blockedError()) : resolve();
      });
    });
  };

  const wrapped = new WeakMap<object, object>();
  const isProxy = new WeakSet<object>();
  function wrap<T extends object>(provider: T): T {
    if (!provider || typeof provider !== 'object') return provider;
    if (isProxy.has(provider)) return provider;
    const existing = wrapped.get(provider);
    if (existing) return existing as T;
    const proxy = new Proxy(provider, {
      get(target, prop, receiver) {
        if (prop === 'request') {
          const original = Reflect.get(target, prop, target) as (args: { method: string }) => Promise<unknown>;
          return async (args: { method: string }) => {
            await gate(args?.method);
            return original.call(target, args);
          };
        }
        if (prop === 'send' || prop === 'sendAsync') {
          // legacy entry points: refuse signing outright rather than try to parse every shape
          const original = Reflect.get(target, prop, target) as (...a: unknown[]) => unknown;
          return (...a: unknown[]) => {
            const method = typeof a[0] === 'string' ? a[0] : (a[0] as { method?: string })?.method;
            if (typeof method === 'string' && SIGNING_METHODS.includes(method) && status !== 'ok' && status !== 'unknown') {
              throw blockedError();
            }
            return original.apply(target, a);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as Function).bind(target) : v;
      },
    });
    wrapped.set(provider, proxy);
    isProxy.add(proxy);
    return proxy as T;
  }

  // window.ethereum: install an accessor before wallets set it.
  const desc = Object.getOwnPropertyDescriptor(window, 'ethereum');
  if (!desc) {
    let real: object | undefined;
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      enumerable: true,
      get: () => (real ? wrap(real) : undefined),
      set: (v: object) => {
        real = v;
      },
    });
  } else if (desc.value && (desc.configurable || desc.writable)) {
    try {
      (window as unknown as { ethereum: object }).ethereum = wrap(desc.value);
    } catch {
      /* wallet locked it down; the EIP-6963 path still applies */
    }
  }

  // EIP-6963: re-announce every discovered provider wrapped.
  const seen = new WeakSet<object>();
  window.addEventListener(
    'eip6963:announceProvider',
    (ev) => {
      const detail = (ev as CustomEvent).detail as { info: unknown; provider: object } | undefined;
      if (!detail || !detail.provider || seen.has(detail)) return;
      ev.stopImmediatePropagation();
      const replacement = Object.freeze({ info: detail.info, provider: wrap(detail.provider) });
      seen.add(replacement);
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: replacement }));
    },
    true,
  );
})();
