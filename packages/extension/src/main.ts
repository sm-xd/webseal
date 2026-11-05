/**
 * Runs in the page's own JavaScript world at document_start, before any page
 * script. It wraps the wallet provider so that signing methods wait for the
 * verifier's verdict and are refused when the page failed verification.
 *
 * Threat model: the page's own code may be the attacker (a tampered bundle).
 * Everything here therefore avoids anything page code can change later:
 *
 * - Built-ins (Reflect.apply, Promise, WeakMap methods, event methods...) are
 *   captured now, before the first page script, and only the captured copies
 *   are used afterwards. No spread, for...of or destructuring of arrays, since
 *   those go through the page-patchable array iterator.
 * - The verdict arrives on a private channel: a detached DOM node created here
 *   and picked up (and removed from the document) by content.ts in the same
 *   injection step. Page code never gets a reference to it, so it can neither
 *   see nor fake the verdict. The status is the event type itself, so no
 *   page-patchable getter is involved in reading it.
 * - Request arguments are read once and copied, so a getter cannot show the
 *   gate one method and the wallet another.
 * - The raw provider never leaks: functions are called with the raw provider
 *   as `this` only inside the wrapper, callbacks the page passes in are called
 *   with the proxy as `this`, and a method returning the raw provider returns
 *   the proxy instead.
 */
import { SIGNING_METHODS } from '@webseal/core';
import { CHANNEL_TAG, EV_HELLO, EV_STATUS_PREFIX, type PageStatus } from './channel.ts';

(() => {
  /* ---------- intrinsics, captured before page code runs ---------- */
  const apply = Reflect.apply;
  const reflectGet = Reflect.get;
  const reflectSet = Reflect.set;
  const ProxyC = Proxy;
  const PromiseC = Promise;
  const ErrorC = Error;
  const isArray = Array.isArray;
  const freeze = Object.freeze;
  const createObject = Object.create;
  const getDesc = Object.getOwnPropertyDescriptor;
  const defineProp = Object.defineProperty;
  const setTimeoutC = setTimeout;
  const clearTimeoutC = clearTimeout;
  const wmGet = WeakMap.prototype.get;
  const wmSet = WeakMap.prototype.set;
  const wsHas = WeakSet.prototype.has;
  const wsAdd = WeakSet.prototype.add;
  const addListener = EventTarget.prototype.addEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const stopImmediate = Event.prototype.stopImmediatePropagation;
  const detailGet = getDesc(CustomEvent.prototype, 'detail')!.get!;
  const CustomEventC = CustomEvent;
  const createElement = Document.prototype.createElement;
  const appendChild = Node.prototype.appendChild;
  const scriptsGet = getDesc(Document.prototype, 'scripts')!.get!;
  const collectionLength = getDesc(HTMLCollection.prototype, 'length')!.get!;
  const doc = document;
  const win = window;

  /* ---------- verdict state ---------- */
  let status: PageStatus = 'pending';
  let reason = '';
  let waiters: Array<() => void> = [];
  const settle = () => {
    const ws = waiters;
    waiters = [];
    for (let i = 0; i < ws.length; i++) ws[i]();
  };

  // Private channel to content.ts. The node is attached only until content.ts
  // removes it, which happens synchronously in the same injection step.
  const channel = apply(createElement, doc, [CHANNEL_TAG]) as Element;
  let claimed = false;
  apply(addListener, channel, [
    EV_HELLO,
    () => {
      // Only extension code can run before the first page script, so a hello
      // that arrives after page scripts exist is not trusted.
      const pageScripts = apply(collectionLength, apply(scriptsGet, doc, []), []) as number;
      if (claimed || pageScripts !== 0) return;
      claimed = true;
    },
  ]);
  const STATUSES: PageStatus[] = ['pending', 'unknown', 'ok', 'fail'];
  for (let i = 0; i < STATUSES.length; i++) {
    const s = STATUSES[i];
    apply(addListener, channel, [
      EV_STATUS_PREFIX + s,
      (ev: Event) => {
        // A failed page has already run untrusted code: only a reload clears it.
        if (!claimed || status === 'fail') return;
        const d = apply(detailGet, ev, []);
        status = s;
        reason = typeof d === 'string' ? d : '';
        settle();
      },
    ]);
  }
  // Without a root element there is no handoff; the status stays pending and signing is refused.
  if (doc.documentElement) apply(appendChild, doc.documentElement, [channel]);

  /* ---------- gate ---------- */
  const signing: Record<string, true> = createObject(null);
  for (let i = 0; i < SIGNING_METHODS.length; i++) signing[SIGNING_METHODS[i]] = true;
  const isSigning = (m: unknown) => typeof m === 'string' && signing[m] === true;
  const allowedNow = () => status === 'ok' || status === 'unknown';

  const rpcError = (message: string, code: number) => {
    const e = new ErrorC(message) as Error & { code: number };
    e.code = code;
    return e;
  };
  const blockedError = () =>
    rpcError(
      `WebSeal blocked this request: the page's code does not match the build its publisher anchored on ENS.` +
        (reason ? ` ${reason}` : ''),
      4100,
    );
  const pendingError = () => rpcError('WebSeal blocked this request: verification did not complete.', 4100);

  /** Resolves when signing is allowed, rejects when it is not. */
  const gate = (): Promise<void> => {
    if (allowedNow()) return PromiseC.resolve();
    if (status === 'fail') return PromiseC.reject(blockedError());
    return new PromiseC<void>((resolve, reject) => {
      const t = setTimeoutC(() => reject(pendingError()), 20000);
      const waiter = () => {
        if (status === 'pending') {
          waiters[waiters.length] = waiter; // a pending re-announce: keep waiting
          return;
        }
        clearTimeoutC(t);
        if (allowedNow()) resolve();
        else reject(status === 'fail' ? blockedError() : pendingError());
      };
      waiters[waiters.length] = waiter;
    });
  };

  /** Copy a JSON-RPC payload, reading every field exactly once. */
  const copyPayload = (p: any) => {
    const method = p.method;
    const params = p.params;
    const id = p.id;
    const jsonrpc = p.jsonrpc;
    return { copy: { jsonrpc, id, method, params }, method };
  };

  /**
   * Inspect the first argument of a non-request provider method (send,
   * sendAsync, _rpcRequest, ...). Returns the argument to pass on, or throws
   * when it carries a signing method while signing is not allowed.
   */
  const checkLegacyArg = (a0: unknown): unknown => {
    if (allowedNow()) return a0;
    if (typeof a0 === 'string') {
      if (isSigning(a0)) throw status === 'fail' ? blockedError() : pendingError();
      return a0;
    }
    if (a0 === null || typeof a0 !== 'object') return a0;
    if (isArray(a0)) {
      const arr = a0 as unknown[];
      const out: unknown[] = [];
      const n = arr.length;
      for (let i = 0; i < n; i++) {
        const item = arr[i];
        if (item !== null && typeof item === 'object') {
          const c = copyPayload(item);
          if (typeof c.method !== 'string' || isSigning(c.method)) throw status === 'fail' ? blockedError() : pendingError();
          out[i] = c.copy;
        } else out[i] = item;
      }
      return out;
    }
    if ('method' in (a0 as object)) {
      const c = copyPayload(a0);
      if (typeof c.method !== 'string' || isSigning(c.method)) throw status === 'fail' ? blockedError() : pendingError();
      return c.copy;
    }
    return a0;
  };

  /* ---------- provider wrapping ---------- */
  const proxyOf = new WeakMap<object, object>();
  const isProxy = new WeakSet<object>();
  const callbackWrappers = new WeakMap<Function, Function>();

  function wrap<T extends object>(provider: T): T {
    if (!provider || typeof provider !== 'object') return provider;
    if (apply(wsHas, isProxy, [provider])) return provider;
    const existing = apply(wmGet, proxyOf, [provider]) as T | undefined;
    if (existing) return existing;

    const target = provider as any;
    const methodCache: Record<PropertyKey, { fn: Function; wrapper: Function }> = createObject(null);
    let proxy: any;

    // Callbacks from the page are called with the proxy as `this`, never the raw provider.
    const wrapCallback = (fn: Function): Function => {
      let w = apply(wmGet, callbackWrappers, [fn]) as Function | undefined;
      if (!w) {
        w = function (this: unknown, ...args: unknown[]) {
          return apply(fn, this === target ? proxy : this, args);
        };
        apply(wmSet, callbackWrappers, [fn, w]);
      }
      return w;
    };
    const fixReturn = (v: unknown) => (v === target ? proxy : v);

    const request = async (args: any) => {
      const method = args === null || typeof args !== 'object' ? undefined : args.method;
      if (typeof method !== 'string') throw rpcError('WebSeal: invalid request, method must be a string', -32600);
      const params = args.params;
      if (isSigning(method)) await gate();
      const original = reflectGet(target, 'request', target) as Function;
      return fixReturn(await apply(original, target, [{ method, params }]));
    };

    const wrapMethod = (prop: PropertyKey, fn: Function): Function => {
      const hit = methodCache[prop];
      if (hit && hit.fn === fn) return hit.wrapper;
      const wrapper = function (...args: unknown[]) {
        const n = args.length;
        const out: unknown[] = [];
        for (let i = 0; i < n; i++) {
          const a = args[i];
          if (typeof a === 'function') out[i] = wrapCallback(a);
          else out[i] = i === 0 ? checkLegacyArg(a) : a;
        }
        return fixReturn(apply(fn, target, out));
      };
      methodCache[prop] = { fn, wrapper };
      return wrapper;
    };

    proxy = new ProxyC(target, {
      get(t, prop) {
        // Proxy invariant: a non-configurable, non-writable data property must
        // read back as its real value, or every access throws. Such a method
        // still runs with the proxy as `this`, so its internal calls come back
        // through this wrapper.
        const own = getDesc(t, prop);
        if (own && !own.configurable && !own.writable && 'value' in own) return own.value;
        if (prop === 'request') return request;
        const v = reflectGet(t, prop, proxy);
        if (typeof v === 'function') return wrapMethod(prop, v);
        if (prop === 'providers' && isArray(v)) {
          const arr = v as object[];
          const out: object[] = [];
          for (let i = 0; i < arr.length; i++) out[i] = wrap(arr[i]);
          return out;
        }
        return v === t ? proxy : v;
      },
      // The page may set plain values (some libraries set flags), but not
      // replace methods: a replaced method would be called with the raw provider.
      set(t, prop, value) {
        if (typeof value === 'function' || prop === 'request') return false;
        return reflectSet(t, prop, value, t);
      },
      // Plain data values may be defined (libraries set flags this way); functions
      // and accessors may not, since either would run with the raw provider.
      defineProperty(t, prop, d) {
        if (prop === 'request' || 'get' in d || 'set' in d || typeof d.value === 'function') return false;
        return defineProp(t, prop, d) === t;
      },
    });
    apply(wmSet, proxyOf, [provider, proxy]);
    apply(wsAdd, isProxy, [proxy]);
    return proxy as T;
  }

  /* ---------- window.ethereum ---------- */
  const desc = getDesc(win, 'ethereum');
  if (!desc) {
    let real: object | undefined;
    defineProp(win, 'ethereum', {
      configurable: true,
      enumerable: true,
      get: () => (real ? wrap(real) : undefined),
      set: (v: object) => {
        real = v;
      },
    });
  } else if (desc.value && (desc.configurable || desc.writable)) {
    try {
      (win as unknown as { ethereum: object }).ethereum = wrap(desc.value);
    } catch {
      /* wallet locked it down; the EIP-6963 path still applies */
    }
  }

  /* ---------- wallet-specific globals ----------
   * Many wallets also expose their provider under their own name, either
   * directly (window.coinbaseWalletExtension) or inside a namespace object
   * (window.phantom.ethereum). Page code could use those to skip the wrapper,
   * so each known name gets the same treatment as window.ethereum. In a
   * namespace object, any property that looks like an EIP-1193 provider is
   * returned wrapped.
   */
  const looksLikeProvider = (v: unknown) => !!v && typeof v === 'object' && typeof (v as { request?: unknown }).request === 'function';
  const nsProxies = new WeakMap<object, object>();
  const guardValue = (v: any) => {
    if (!v || typeof v !== 'object') return v;
    if (looksLikeProvider(v)) return wrap(v);
    let p = apply(wmGet, nsProxies, [v]) as object | undefined;
    if (!p) {
      p = new ProxyC(v, {
        get(t: any, prop) {
          const own = getDesc(t, prop);
          if (own && !own.configurable && !own.writable && 'value' in own) return own.value;
          const x = reflectGet(t, prop, t);
          return looksLikeProvider(x) ? wrap(x) : x;
        },
      });
      apply(wmSet, nsProxies, [v, p]);
    }
    return p;
  };
  const VENDOR_GLOBALS = [
    'coinbaseWalletExtension', 'okxwallet', 'trustwallet', 'trustWallet', 'rabby', 'zerionWallet', 'BinanceChain',
    'phantom', 'bitkeep', 'xfi', 'coin98', 'tokenpocket', 'braveEthereum', 'frontier', 'enkrypt', 'keplr', 'backpack',
  ];
  for (let i = 0; i < VENDOR_GLOBALS.length; i++) {
    const name = VENDOR_GLOBALS[i];
    const d = getDesc(win, name);
    if (!d) {
      let real: unknown;
      defineProp(win, name, {
        configurable: true,
        enumerable: true,
        get: () => guardValue(real),
        set: (v: unknown) => {
          real = v;
        },
      });
    } else if ('value' in d && d.value && (d.configurable || d.writable)) {
      try {
        (win as any)[name] = guardValue(d.value);
      } catch {
        /* locked down */
      }
    }
  }

  /* ---------- EIP-6963: re-announce every provider wrapped ---------- */
  const seen = new WeakSet<object>();
  apply(addListener, win, [
    'eip6963:announceProvider',
    (ev: Event) => {
      const detail = apply(detailGet, ev, []) as { info: unknown; provider: object } | undefined;
      if (!detail || typeof detail !== 'object' || apply(wsHas, seen, [detail])) return;
      const provider = detail.provider;
      if (!provider) return;
      apply(stopImmediate, ev, []);
      const replacement = freeze({ info: detail.info, provider: wrap(provider) });
      apply(wsAdd, seen, [replacement]);
      apply(dispatch, win, [new CustomEventC('eip6963:announceProvider', { detail: replacement })]);
    },
    true,
  ]);
})();
