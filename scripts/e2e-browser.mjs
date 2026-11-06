// End-to-end test in Chromium with the extension loaded.
// Requires: pnpm build (demo + extension) and a manifest in apps/demo/dist.
import { createRequire } from 'node:module';
// Playwright may be installed globally (as in CI containers) rather than in this repo.
const require = createRequire(import.meta.url);
const { chromium } = (() => {
  for (const spec of ['playwright', '/opt/node-tools/node_modules/playwright']) {
    try { return require(spec); } catch {}
  }
  throw new Error('playwright not found: npm i -g playwright && npx playwright install chromium');
})();
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXT = join(ROOT, 'packages/extension/dist');
const DEMO = join(ROOT, 'apps/demo');
const CLI = join(ROOT, 'packages/cli/dist/webseal.js');
const PORT = 4199;
const ORIGIN = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS ?? join(ROOT, 'docs/screenshots');
await mkdir(SHOTS, { recursive: true });

const run = (f, a = []) => execFileSync('node', [f, ...a], { cwd: ROOT, stdio: 'pipe' }).toString();
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

// clean state + manifest
run(join(DEMO, 'restore.mjs'));
run(CLI, ['build', '--dist', join(DEMO, 'dist'), '--name', 'acme-demo.eth']);
const manifestRaw = await readFile(join(DEMO, 'dist/.well-known/webseal.json'));
const HASH = createHash('sha256').update(manifestRaw).digest('hex');

const server = spawn('node', [join(DEMO, 'server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));

const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  // *.eth.limo is mapped to the local demo server for the derived-name check.
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP *.eth.limo 127.0.0.1,MAP insecure.test 127.0.0.1'],
  viewport: { width: 1100, height: 760 },
  deviceScaleFactor: 2,
});
// Fake wallet so we can test the gate without MetaMask. Injected into every
// frame, like real wallets. It behaves like an EventEmitter-based provider:
// listeners are called with the provider as `this`, and on() returns it.
await ctx.addInitScript(() => {
  const calls = [];
  const listeners = {};
  window.__walletCalls = calls;
  window.ethereum = {
    isFake: true,
    request: async ({ method }) => {
      calls.push(method);
      return method === 'eth_chainId' ? '0xaa36a7' : method === 'eth_requestAccounts' || method === 'eth_accounts' ? ['0x1234567890123456789012345678901234567890'] : '0xsigned';
    },
    sendAsync(payload, cb) {
      for (const p of Array.isArray(payload) ? payload : [payload]) calls.push(p.method);
      cb(null, { result: '0xsigned' });
    },
    on(ev, fn) {
      (listeners[ev] ||= []).push(fn);
      return this;
    },
    removeListener() {
      return this;
    },
    emit(ev) {
      for (const fn of listeners[ev] || []) fn.call(this);
    },
  };
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
console.log(`extension ${extId}`);

const page = await ctx.newPage();
const tabIdOf = async () => sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
const badge = async () => sw.evaluate(async (id) => chrome.action.getBadgeText({ tabId: id }), await tabIdOf());
const tryRequest = (method) =>
  page.evaluate(async (m) => {
    try {
      const r = await window.ethereum.request({ method: m });
      return { ok: true, r };
    } catch (e) {
      return { ok: false, message: e.message, code: e.code };
    }
  }, method);
const settle = () => page.waitForTimeout(900);
const whyFailed = async () => sw.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`]?.reason ?? '', await tabIdOf());

// 1. no anchor -> unknown, nothing blocked
await page.goto(ORIGIN);
await settle();
check((await badge()) === '', 'unpinned site shows no badge');
check((await tryRequest('personal_sign')).ok, 'unpinned site: signing allowed');
check((await page.$('#webseal-banner')) === null, 'unpinned site: no banner');

// 2. pin manifest hash -> ok
await sw.evaluate(async ([host, hash]) => chrome.storage.local.set({ pins: { [host]: { kind: 'hash', hash } } }), [`localhost:${PORT}`, HASH]);
await page.reload();
await settle();
check((await badge()) === '✓', 'pinned clean site shows ✓');
check((await tryRequest('personal_sign')).ok, 'clean site: signing allowed');
check((await tryRequest('eth_sendTransaction')).ok, 'clean site: sendTransaction allowed');
// Through the dApp's own buttons (viem), as a user would: the send reaches the wallet.
const clickSend = async () => {
  await page.click('#connect');
  await page.waitForFunction(() => !document.getElementById('send').disabled, null, { timeout: 5000 }).catch(() => {});
  await page.click('#send');
  await page.waitForTimeout(800);
  return ((await page.textContent('#log')) ?? '').split('\n')[0];
};
{
  const line = await clickSend();
  check(/sent: /.test(line), `clean site: the dApp's Send button reaches the wallet (${line.trim()})`);
}
await page.screenshot({ path: join(SHOTS, 'clean.png') });
const demoTab = await tabIdOf();
const popupClean = await ctx.newPage();
await popupClean.goto(`chrome-extension://${extId}/popup.html?tab=${demoTab}`);
await popupClean.waitForTimeout(500);
await popupClean.screenshot({ path: join(SHOTS, 'popup-clean.png'), fullPage: true });
await popupClean.close();

// 3. tamper -> fail, blocked
console.log(run(join(DEMO, 'tamper.mjs')).trim().split('\n').slice(-3).join('\n'));
await page.bringToFront();
await page.reload();
await settle();
check((await badge()) === '✗', 'tampered site shows ✗');
check((await page.$('#webseal-banner')) !== null, 'tampered site: banner shown');
const blocked = await tryRequest('eth_sendTransaction');
check(!blocked.ok && /WebSeal blocked/.test(blocked.message) && blocked.code === 4100, `tampered site: sendTransaction blocked (${blocked.message})`);
check(!(await tryRequest('personal_sign')).ok, 'tampered site: personal_sign blocked');
check((await tryRequest('eth_chainId')).ok, 'tampered site: read-only eth_chainId still allowed');
check((await tryRequest('eth_requestAccounts')).ok, 'tampered site: connecting still allowed');
{
  const line = await clickSend();
  // Must be WebSeal's refusal, not some other failure (e.g. viem rejecting a malformed address).
  check(/WebSeal blocked this request/.test(line), `tampered site: the dApp's Send button is refused by WebSeal (${line.trim().slice(0, 90)})`);
}
await page.screenshot({ path: join(SHOTS, 'tampered.png') });
const popupBad = await ctx.newPage();
await popupBad.goto(`chrome-extension://${extId}/popup.html?tab=${demoTab}`);
await popupBad.waitForTimeout(500);
await popupBad.screenshot({ path: join(SHOTS, 'popup-tampered.png'), fullPage: true });
const popupText = await popupBad.textContent('body');
check(/mismatch/.test(popupText) && /index-/.test(popupText), 'popup names the changed file');
await popupBad.close();
await page.bringToFront();

// 4. forged status from page JS must not unblock
await page.evaluate(() => {
  for (let seq = 0; seq < 5; seq++) window.postMessage({ type: 'webseal:status', seq, key: 'forged', status: 'ok' }, '*');
});
await page.waitForTimeout(300);
check(!(await tryRequest('eth_sendTransaction')).ok, 'forged status message from the page does not unblock');

// 5. injected script on a clean page flips to fail
run(join(DEMO, 'restore.mjs'));
await page.reload();
await settle();
check((await badge()) === '✓', 'restored site shows ✓ again');
await page.evaluate(() => {
  const s = document.createElement('script');
  s.src = '/assets/not-in-release.js';
  document.head.appendChild(s);
});
await page.waitForTimeout(1200);
check((await badge()) === '✗', 'script injected after load flips to ✗');
check(!(await tryRequest('personal_sign')).ok, 'signing blocked after late injection');

// 6. Page code on a tampered page tries to get around the wallet gate.
//    Each attack runs on a fresh load; the wallet must never see eth_sendTransaction.
run(join(DEMO, 'tamper.mjs'));
const CSS = (await readFile(join(DEMO, 'dist/index.html'), 'utf8')).match(/href="(\/assets\/[^"]+\.css)"/)[1];
const attack = async (label, fn) => {
  await page.reload();
  await settle();
  const r = await page.evaluate(fn, CSS);
  const sent = await page.evaluate(() => window.__walletCalls.includes('eth_sendTransaction'));
  check(!sent && r !== 'ALLOWED', `bypass blocked: ${label}${typeof r === 'string' && r !== 'ALLOWED' ? ` (${r})` : ''}`);
};
await attack('overriding Array.prototype.includes', async () => {
  Array.prototype.includes = () => false;
  try { await window.ethereum.request({ method: 'eth_sendTransaction', params: [{}] }); return 'ALLOWED'; } catch (e) { return e.code; }
});
await attack('overriding crypto.subtle.digest and posting a forged verdict', async () => {
  crypto.subtle.digest = async () => new Uint8Array(32).buffer;
  for (let seq = 0; seq < 6; seq++) window.postMessage({ type: 'webseal:status', seq, key: '0'.repeat(64), status: 'ok' }, '*');
  await new Promise((r) => setTimeout(r, 200));
  try { await window.ethereum.request({ method: 'eth_sendTransaction', params: [{}] }); return 'ALLOWED'; } catch (e) { return e.code; }
});
await attack('replaying a captured verdict with status flipped', async () => {
  window.addEventListener('message', (e) => e.data?.type?.startsWith?.('webseal') && window.postMessage({ ...e.data, status: 'ok' }, '*'), true);
  const s = document.createElement('script'); s.src = '/assets/again.js'; document.head.appendChild(s);
  await new Promise((r) => setTimeout(r, 600));
  try { await window.ethereum.request({ method: 'eth_sendTransaction', params: [{}] }); return 'ALLOWED'; } catch (e) { return e.code; }
});
await attack('a method getter that changes between gate and wallet', async () => {
  let reads = 0;
  const args = { get method() { return reads++ === 0 ? 'eth_chainId' : 'eth_sendTransaction'; }, params: [{}] };
  try { await window.ethereum.request(args); } catch (e) { return e.code; }
  return 'ok';
});
await attack('a batched legacy sendAsync call', async () => {
  try { window.ethereum.sendAsync([{ id: 1, jsonrpc: '2.0', method: 'eth_sendTransaction', params: [{}] }], () => {}); return 'ALLOWED'; } catch (e) { return e.code; }
});
await attack('replacing ethereum.request on the provider', async () => {
  try { window.ethereum.request = function (a) { return this.request(a); }; } catch {}
  try { await window.ethereum.request({ method: 'eth_sendTransaction', params: [{}] }); return 'ALLOWED'; } catch (e) { return e.code; }
});
await attack('the raw provider leaking as `this` in an event listener', async () => {
  let leaked;
  window.ethereum.on('x', function () { leaked = this; });
  window.ethereum.emit('x');
  try { await leaked.request({ method: 'eth_sendTransaction', params: [{}] }); return 'ALLOWED'; } catch (e) { return e.code; }
});
await attack('the raw provider returned by on()', async () => {
  try { await window.ethereum.on('y', () => {}).request({ method: 'eth_sendTransaction', params: [{}] }); return 'ALLOWED'; } catch (e) { return e.code; }
});
await attack('a same-origin iframe showing a clean release file', async (css) => {
  const f = document.createElement('iframe');
  f.src = css;
  document.body.appendChild(f);
  await new Promise((r) => (f.onload = r));
  await new Promise((r) => setTimeout(r, 800));
  const eth = f.contentWindow.ethereum;
  if (!eth) return 'no wallet in frame';
  try { await eth.request({ method: 'eth_sendTransaction', params: [{}] }); return f.contentWindow.__walletCalls.includes('eth_sendTransaction') ? 'ALLOWED' : 'not sent'; } catch (e) { return e.code; }
});
await attack('an about:blank iframe', async () => {
  const f = document.createElement('iframe');
  document.body.appendChild(f);
  await new Promise((r) => setTimeout(r, 500));
  const eth = f.contentWindow.ethereum;
  if (!eth || eth === window.ethereum) return 'no separate wallet in frame';
  try { await eth.request({ method: 'eth_sendTransaction', params: [{}] }); return 'ALLOWED'; } catch (e) { return e.code; }
});
{
  await page.reload();
  await settle();
  const [popup] = await Promise.all([ctx.waitForEvent('page'), page.evaluate((css) => { window.__popup = window.open(css); }, CSS)]);
  await popup.waitForLoadState();
  await popup.waitForTimeout(1500);
  const r = await page.evaluate(async () => {
    const eth = window.__popup.ethereum;
    if (!eth) return 'no wallet in popup';
    try { await eth.request({ method: 'eth_sendTransaction', params: [{}] }); return 'ALLOWED'; } catch (e) { return e.code; }
  });
  check(r !== 'ALLOWED', `bypass blocked: a same-origin window opened on a clean release file (${r})`);
  await popup.close();
  await page.bringToFront();
}
await page.evaluate(() => document.getElementById('webseal-banner')?.remove());
await page.waitForTimeout(100);
check((await page.$('#webseal-banner')) !== null, 'banner comes back after page code removes it');

// 7. Re-check in place never turns a failed page green: its tampered code already ran.
run(join(DEMO, 'restore.mjs'));
{
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html?tab=${demoTab}`);
  await pop.waitForTimeout(400);
  await pop.click('#recheck');
  await pop.waitForTimeout(1500);
  check(/Blocked/.test(await pop.textContent('#summary')), 're-check after restoring the server keeps a failed page blocked');
  await pop.close();
  await page.bringToFront();
}

// 8. Clean page: no false alarms, no needless work.
await page.reload();
await settle();
check((await badge()) === '✓', 'clean page after restore shows ✓');
const lastCheck = () => sw.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`]?.report?.checkedAt, demoTab);
const t0 = await lastCheck();
await page.evaluate(async () => {
  for (let i = 0; i < 10; i++) {
    await fetch('/.well-known/webseal.json?poll=' + i); // stands in for RPC polling
    await new Promise((r) => setTimeout(r, 150));
  }
});
await page.waitForTimeout(600);
check((await lastCheck()) === t0, 'ordinary fetches (RPC polling) do not trigger re-verification');
await page.evaluate((css) => {
  history.pushState({}, '', '/dashboard');
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = css;
  document.head.appendChild(l);
}, CSS);
await page.waitForTimeout(800);
check((await badge()) === '✓', 'client-side route change (pushState) stays ✓');
check((await tryRequest('eth_sendTransaction')).ok, 'client-side route: signing still allowed');
{
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html?tab=${demoTab}`);
  await pop.waitForTimeout(400);
  await pop.click('#recheck');
  await pop.waitForTimeout(1500);
  check(/^Verified/.test(await pop.textContent('#summary')), 're-check in place on a clean page stays verified, without a reload');
  await pop.close();
  await page.bringToFront();
}

// 9. *.eth.limo host whose name has no webseal record: unknown, not red. Needs the Sepolia RPC.
{
  const p = await ctx.newPage();
  await p.goto(`http://vitalik.eth.limo:${PORT}/`);
  await p.waitForTimeout(6000);
  const id = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
  const st = await sw.evaluate(async (i) => (await chrome.storage.session.get(`tab:${i}`))[`tab:${i}`], id);
  if (st?.report?.manifest?.error?.includes('lookup')) console.log(`SKIP  derived ENS name without a record (RPC unreachable: ${st.report.manifest.error})`);
  else {
    check(st?.status === 'unknown', `derived *.eth.limo name without a record is unknown, not failed (${st?.status})`);
    check((await p.$('#webseal-banner')) === null, 'derived *.eth.limo name without a record: no banner');
  }
  await p.close();
  await page.bringToFront();
}

// 9b. Plain-http host (not localhost, so no Web Crypto): the JS SHA-256 fallback still verifies it.
{
  await sw.evaluate(async ([host, hash]) => {
    const { pins } = await chrome.storage.local.get('pins');
    await chrome.storage.local.set({ pins: { ...pins, [host]: { kind: 'hash', hash } } });
  }, [`insecure.test:${PORT}`, HASH]);
  const p = await ctx.newPage();
  await p.goto(`http://insecure.test:${PORT}/`);
  await p.waitForTimeout(1500);
  const id = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
  const st = await sw.evaluate(async (i) => (await chrome.storage.session.get(`tab:${i}`))[`tab:${i}`], id);
  check(!(await p.evaluate(() => isSecureContext)) && st?.status === 'ok', `plain-http (insecure context) clean site verifies (${st?.status})`);
  await p.close();
  await page.bringToFront();
}

// 9c. Pinned by ENS name, resolved through a local fake ENS RPC (scripts/fixtures/fake-ens-rpc.mjs).
// (Back to the root URL first: section 8 left the page on /dashboard, which this server answers with a 404.)
await page.goto(ORIGIN);
await settle();
{
  const other = 'b'.repeat(64);
  const records = { 'webseal.acme-sub.eth': `v1:sha256:${HASH}`, 'acme-roll.eth': `v1:sha256:${other},${HASH}`, 'acme-stale.eth': `v1:sha256:${other}` };
  const ens = spawn('node', [join(ROOT, 'scripts/fixtures/fake-ens-rpc.mjs'), '8595', JSON.stringify(records)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => ens.stdout.on('data', (d) => /ready/.test(String(d)) && r()));
  await sw.evaluate(async () => chrome.storage.local.set({ settings: { chain: 'sepolia', rpc: 'http://localhost:8596' } }));
  const pinName = async (name) => {
    await sw.evaluate(async ([host, n]) => {
      const { pins } = await chrome.storage.local.get('pins');
      await chrome.storage.local.set({ pins: { ...pins, [host]: { kind: 'ens', name: n } } });
    }, [`localhost:${PORT}`, name]);
    await page.reload();
    await settle();
    return badge();
  };
  { const b = await pinName('acme-sub.eth'); check(b === '✓', `ENS pin: record only on webseal.<name> verifies ✓ (badge ${JSON.stringify(b)} ${await whyFailed()})`); }
  {
    const pop = await ctx.newPage();
    await pop.goto(`chrome-extension://${extId}/popup.html?tab=${demoTab}`);
    await pop.waitForTimeout(500);
    check(/acme-sub\.eth \(sepolia\)/.test(await pop.textContent('#anchor')), 'ENS pin: popup shows the ENS anchor');
    await pop.close();
    await page.bringToFront();
  }
  check((await pinName('acme-roll.eth')) === '✓', 'ENS pin: rollout record with two hashes accepts the served build');
  check((await pinName('acme-stale.eth')) === '✗', 'ENS pin: record anchoring a different build is ✗');
  await sw.evaluate(async ([host, hash]) => {
    const { pins } = await chrome.storage.local.get('pins');
    await chrome.storage.local.set({ pins: { ...pins, [host]: { kind: 'hash', hash } }, settings: { chain: 'sepolia' } });
  }, [`localhost:${PORT}`, HASH]);
  ens.kill();
}

// 9d. A tampered same-origin frame inside a clean page: the page holds signing from the
//     moment the frame starts, before any of the frame's own scripts run.
{
  const { writeFile, rm } = await import('node:fs/promises');
  const files = {
    // Uses the top page's wallet straight from its first script.
    'evil-frame.html': `<!doctype html><script src="/evil-frame.js"></script>`,
    'evil-frame.js': `parent.__frameResult = parent.ethereum.request({ method: 'eth_sendTransaction', params: [{}] }).then(() => 'ALLOWED', (e) => 'blocked ' + e.code);`,
    // Plants a timer in the top page that runs the top page's own (bound) request function
    // 1.5 s later, then removes itself before it can be verified.
    'planter-frame.html': `<!doctype html><script src="/planter-frame.js"></script>`,
    'planter-frame.js': `const p = parent; p.setTimeout(p.ethereum.request.bind(p.ethereum, { method: 'eth_sendTransaction', params: [{}] }), 1500); p.__planted = 'planted'; frameElement.remove();`,
  };
  for (const [n, body] of Object.entries(files)) await writeFile(join(DEMO, 'dist', n), body);
  const waitBadge = async (want, ms = 6000) => {
    let b;
    for (let t = 0; t < ms; t += 200) {
      if ((b = await badge()) === want) return b;
      await page.waitForTimeout(200);
    }
    return b;
  };
  try {
    for (const [file, label, key] of [['/evil-frame.html', 'a tampered same-origin frame using the page wallet at once', '__frameResult'], ['/planter-frame.html', 'a frame that plants code in the page and removes itself', '__planted']]) {
      await page.reload();
      const before = await waitBadge('✓');
      const r = await page.evaluate(async ([src, k]) => {
        const f = document.createElement('iframe');
        f.src = src;
        document.body.appendChild(f);
        for (let i = 0; i < 50 && !window[k]; i++) await new Promise((x) => setTimeout(x, 50));
        if (!window[k]) return 'frame script did not run';
        if (typeof window[k] === 'string') return window[k];
        return Promise.race([window[k], new Promise((x) => setTimeout(() => x('no answer within 8 s'), 8000))]);
      }, [file, key]);
      await page.waitForTimeout(2500); // let a planted timer fire
      const sent = await page.evaluate(() => window.__walletCalls.includes('eth_sendTransaction'));
      check(before === '✓' && !sent && r !== 'ALLOWED' && r !== 'frame script did not run', `bypass blocked: ${label} (${r}; wallet saw tx: ${sent})`);
      check((await badge()) === '✗', `${label}: the page turns ✗ (${await whyFailed()})`);
    }
  } finally {
    for (const n of Object.keys(files)) await rm(join(DEMO, 'dist', n), { force: true });
  }
}

// 9e. Code that is not a script tag: WebAssembly fetched at runtime, a service worker.
{
  await page.reload();
  await settle();
  await page.evaluate(() => fetch('/assets/not-in-release.wasm').catch(() => {}));
  await page.waitForTimeout(800);
  check((await badge()) === '✗', 'unlisted WebAssembly fetched at runtime flips to ✗');

  const { writeFile, rm } = await import('node:fs/promises');
  const swFile = join(DEMO, 'dist/sw-not-in-release.js');
  await writeFile(swFile, `self.addEventListener('fetch', () => {});`);
  try {
    await page.reload();
    await settle();
    await page.evaluate(() => navigator.serviceWorker.register('/sw-not-in-release.js'));
    await page.waitForTimeout(3500);
    check((await badge()) === '✗', 'unlisted service worker registered by the page flips to ✗');
    await page.evaluate(async () => {
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    });
  } finally {
    await rm(swFile, { force: true });
  }
  await page.reload();
  await settle();
  check((await badge()) === '✓', 'clean again after the service worker is gone');
}

// 10. The service worker is stopped (Chrome does this after ~30 s idle): the popup still knows the verdict.
{
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.waitForTimeout(1000);
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html?tab=${demoTab}`);
  await pop.waitForTimeout(1000);
  check(/^Verified/.test(await pop.textContent('#summary')), 'popup keeps the verdict after the service worker restarts');
  await pop.close();
}
await ctx.close();

// 11. A wallet installed as an extension (scripts/fixtures/fake-wallet), injected the way
//     MetaMask-style wallets are, next to WebSeal. Covers real injection order and frames.
{
  const WALLET = join(ROOT, 'scripts/fixtures/fake-wallet');
  const exts = `${EXT},${WALLET}`;
  const ctx2 = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${exts}`, `--load-extension=${exts}`] });
  await new Promise((r) => setTimeout(r, 1500));
  const sw2 = ctx2.serviceWorkers().find((w) => w.url().endsWith('/background.js')) ?? (await ctx2.waitForEvent('serviceworker'));
  await sw2.evaluate(async ([host, hash]) => chrome.storage.local.set({ pins: { [host]: { kind: 'hash', hash } } }), [`localhost:${PORT}`, HASH]);
  const p = await ctx2.newPage();
  const sendVia = (where) =>
    p.evaluate(async (where) => {
      let eth;
      if (where === 'window') eth = window.ethereum;
      else if (where === 'phantom') eth = window.phantom?.ethereum;
      else if (where === 'coinbase') eth = window.coinbaseWalletExtension;
      else if (where === '6963') {
        const got = [];
        const h = (e) => got.push(e.detail.provider);
        window.addEventListener('eip6963:announceProvider', h);
        window.dispatchEvent(new Event('eip6963:requestProvider'));
        await new Promise((r) => setTimeout(r, 100));
        window.removeEventListener('eip6963:announceProvider', h);
        eth = got[0];
      } else {
        const f = document.createElement('iframe');
        if (where === 'srcdoc') f.srcdoc = '<p>x</p>';
        document.body.appendChild(f);
        await new Promise((r) => setTimeout(r, 800));
        eth = f.contentWindow.ethereum;
      }
      if (!eth) return 'no wallet';
      try { await eth.request({ method: 'eth_sendTransaction', params: [{}] }); return 'allowed'; } catch (e) { return `blocked ${e.code}`; }
    }, where);
  await p.goto(ORIGIN);
  await p.waitForTimeout(1200);
  check((await p.evaluate(() => !!window.ethereum?.isExtWallet)) && (await sendVia('window')) === 'allowed', 'extension wallet: clean page can send');
  check((await sendVia('6963')) === 'allowed', 'extension wallet: clean page can send via EIP-6963');
  run(join(DEMO, 'tamper.mjs'));
  for (const where of ['window', '6963', 'about:blank', 'srcdoc', 'phantom', 'coinbase']) {
    await p.reload();
    await p.waitForTimeout(1200);
    const r = await sendVia(where);
    check(r === 'blocked 4100', `extension wallet: tampered page blocked via ${where} (${r})`);
  }
  run(join(DEMO, 'restore.mjs'));
  await ctx2.close();
}
server.kill();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
