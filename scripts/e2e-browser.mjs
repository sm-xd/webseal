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
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1100, height: 760 },
  deviceScaleFactor: 2,
});
// Fake wallet so we can test the gate without MetaMask.
await ctx.addInitScript(() => {
  const calls = [];
  window.__walletCalls = calls;
  window.ethereum = {
    isFake: true,
    request: async ({ method }) => {
      calls.push(method);
      return method === 'eth_chainId' ? '0xaa36a7' : method === 'eth_requestAccounts' || method === 'eth_accounts' ? ['0x1234567890123456789012345678901234567890'] : '0xsigned';
    },
    on() {},
    removeListener() {},
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

await ctx.close();
server.kill();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
