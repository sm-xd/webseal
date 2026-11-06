// Records the real demo flow for the 2-minute video: timed screenshot sequences of the wagmi app
// (dark mode, 2x pixel density) with WebSeal and the test wallet, the positions of every click and
// field, the extension badge per frame, and the real output of every CLI command shown.
//
//   node scripts/video/capture.mjs      -> video-assets/footage/ (footage.json + frames)
//
// Needs the wagmi build anchored on smxreds.eth (Sepolia) and served on :4174 (started if not).
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = join(ROOT, 'video-assets/footage');
const EXT = join(ROOT, 'packages/extension/dist');
const WALLET = join(ROOT, 'scripts/fixtures/fake-wallet');
const CLI = join(ROOT, 'packages/cli/dist/webseal.js');
const DIST = join(ROOT, 'apps/wagmi-playground/dist');
const NAME = 'smxreds.eth';
const REPO = 'https://github.com/sm-xd/webseal.git';
const PORT = 4174, ORIGIN = `http://localhost:${PORT}`;
const RECIPIENT = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'; // the test wallet's own account
const VIEW = { width: 1280, height: 800 };
const log = (...a) => console.log('[capture]', ...a);

const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
function run(file, args) {
  try {
    return strip(execFileSync('node', [file, ...args], { cwd: ROOT, stdio: 'pipe', maxBuffer: 64 << 20 }).toString());
  } catch (e) {
    return strip(`${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
}
const webseal = (...a) => run(CLI, a);
const wagmi = (...a) => run(join(ROOT, 'scripts/wagmi.mjs'), a);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const footage = { view: VIEW, scale: 2, seqs: {}, terminal: {} };
const term = (name, cmd, out) => { footage.terminal[name] = { cmd, out: out.replace(/\r/g, '').trimEnd() }; log(`terminal ${name}`); };

wagmi('restore');
let server;
if (!(await fetch(ORIGIN).then((r) => r.ok, () => false))) {
  server = spawn('node', [join(ROOT, 'apps/demo/server.mjs')], { env: { ...process.env, PORT: String(PORT), WEBSEAL_DEMO_DIST: DIST }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 700));
}

const contexts = [];
async function browser(withWebSeal) {
  const exts = withWebSeal ? `${EXT},${WALLET}` : WALLET;
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, viewport: VIEW, deviceScaleFactor: 2, colorScheme: 'dark',
    args: [`--disable-extensions-except=${exts}`, `--load-extension=${exts}`],
  });
  contexts.push(ctx);
  for (const p of ctx.pages()) await p.close().catch(() => {});
  if (!withWebSeal) return { ctx };
  let sw;
  for (let i = 0; i < 40 && !sw; i++) {
    for (const w of ctx.serviceWorkers()) if ((await w.evaluate(() => chrome.runtime.getManifest().name).catch(() => '')) === 'WebSeal') sw = w;
    if (!sw) await new Promise((r) => setTimeout(r, 250));
  }
  await sw.evaluate(async ([host, name]) => chrome.storage.local.set({ pins: { [host]: { kind: 'ens', name } }, settings: { chain: 'sepolia' } }), [`localhost:${PORT}`, NAME]);
  return { ctx, sw, extId: new URL(sw.url()).host };
}

/** Screenshots a page continuously (JPEG, ~8-10 fps at 2x) and records named events with element boxes. */
function recorder(name, page, badgeOf) {
  const dir = join(OUT, name);
  const seq = { frames: [], events: [] };
  footage.seqs[name] = seq;
  const t0 = Date.now();
  let on = true;
  const loop = (async () => {
    await mkdir(dir, { recursive: true });
    while (on) {
      const t = Date.now() - t0;
      const buf = await page.screenshot({ type: 'jpeg', quality: 93 }).catch(() => null);
      if (!buf) continue;
      const file = `${name}/${String(seq.frames.length).padStart(4, '0')}.jpg`;
      await writeFile(join(OUT, file), buf);
      seq.frames.push({ t, file, badge: badgeOf ? await badgeOf().catch(() => '') : null });
    }
  })();
  const box = async (sel) => (sel ? await page.locator(sel).first().boundingBox().catch(() => null) : null);
  return {
    mark: async (event, sel) => seq.events.push({ t: Date.now() - t0, name: event, box: await box(sel) }),
    stop: async () => {
      on = false; await loop; seq.duration = Date.now() - t0;
      seq.firstPaint = await firstPaint(seq);
      log(`seq ${name}: ${seq.frames.length} frames, ${(seq.duration / 1000).toFixed(1)} s, first paint at ${seq.firstPaint} ms`);
    },
  };
}
/**
 * Where playback should start: the second painted frame. Frames before the first paint are a
 * blank tab (a tiny JPEG), and headless Chromium's very first paint can come out as a tiled
 * compositor glitch (seen on two of three recordings).
 */
async function firstPaint(seq) {
  const { stat } = await import('node:fs/promises');
  let painted = 0;
  for (const f of seq.frames) if ((await stat(join(OUT, f.file))).size > 100_000 && ++painted === 2) return f.t;
  return 0;
}
const ADDRESS = '#root > div:has(input[name="address"]) input[name="address"]';
const VALUE = '#root > div:has(input[name="address"]) input[name="value"]';
const SEND = '#root > div:has(input[name="address"]) button[type="submit"]';
const SEND_CELL = '#root > div:has(input[name="address"])';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(page) {
  const disc = page.getByRole('button', { name: 'Disconnect' });
  if (await disc.isVisible().catch(() => false)) return;
  await page.getByRole('button', { name: 'Test Wallet' }).click();
  await disc.waitFor({ timeout: 10000 });
}
async function typeAndSend(page, r, { awaitResult = true } = {}) {
  await r.mark('click-address', ADDRESS);
  await page.locator(ADDRESS).click();
  await r.mark('type-address-start', ADDRESS);
  await page.locator(ADDRESS).pressSequentially(RECIPIENT, { delay: 28 });
  await r.mark('type-address-end', ADDRESS);
  await wait(250);
  await r.mark('click-value', VALUE);
  await page.locator(VALUE).click();
  await page.locator(VALUE).pressSequentially('0.0001', { delay: 60 });
  await wait(350);
  await r.mark('click-send', SEND);
  await page.locator(SEND).click();
  if (awaitResult) await page.locator(SEND_CELL).getByText(/Transaction Hash|Error/).waitFor({ timeout: 15000 }).catch(() => {});
  await r.mark('send-result', SEND_CELL);
  await wait(1400);
}

try {
  /* terminal: release */
  term('build', `webseal build --dist apps/wagmi-playground/dist --name ${NAME} --repo ${REPO}`, webseal('build', '--dist', 'apps/wagmi-playground/dist', '--name', NAME, '--repo', REPO));
  term('record', `webseal record --name ${NAME} --chain sepolia`, webseal('record', '--name', NAME, '--chain', 'sepolia'));
  term('writers', `webseal writers --name ${NAME} --chain sepolia`, webseal('writers', '--name', NAME, '--chain', 'sepolia'));

  const W = await browser(true);
  const tabBadge = (page) => async () => {
    const id = await W.sw.evaluate(async (url) => {
      const tabs = (await chrome.tabs.query({})).filter((t) => t.url?.startsWith(url));
      return tabs.length ? Math.max(...tabs.map((t) => t.id)) : undefined;
    }, ORIGIN);
    return id === undefined ? '' : W.sw.evaluate((i) => chrome.action.getBadgeText({ tabId: i }), id);
  };
  const waitBadge = async (badge, want) => { for (let t = 0; t < 20000 && (await badge()) !== want; t += 200) await wait(200); };
  const popupShot = async (page, file) => {
    const id = await W.sw.evaluate(async (url) => Math.max(...(await chrome.tabs.query({})).filter((t) => t.url?.startsWith(url)).map((t) => t.id)), ORIGIN);
    const p = await W.ctx.newPage();
    await p.setViewportSize({ width: 380, height: 600 });
    await p.goto(`chrome-extension://${W.extId}/popup.html?tab=${id}`);
    await wait(900);
    await p.screenshot({ path: join(OUT, file) });
    const rows = await p.evaluate(() => [...document.querySelectorAll('#files li')].map((li) => { const r = li.getBoundingClientRect(); return { y: r.y, h: r.height, text: li.textContent }; }));
    const writers = await p.locator('#writersRow').boundingBox();
    await p.close();
    return { file, rows, writers };
  };

  /* clean: load, verify, popup, type and send */
  let page = await W.ctx.newPage();
  const badge = tabBadge(page);
  let r = recorder('clean', page, badge);
  await wait(300);
  await r.mark('goto');
  await page.goto(ORIGIN);
  await waitBadge(badge, '✓');
  await r.mark('verified');
  await wait(900);
  await connect(page);
  await typeAndSend(page, r);
  await r.stop();
  footage.popupClean = await popupShot(page, 'popup-clean.png');
  await page.close();

  /* the attack */
  term('tamper', 'pnpm wagmi:tamper', wagmi('tamper'));
  page = await W.ctx.newPage();
  r = recorder('tampered', page, tabBadge(page));
  await wait(300);
  await r.mark('goto');
  await page.goto(ORIGIN);
  await waitBadge(tabBadge(page), '✗');
  await page.locator('#webseal-banner').waitFor({ timeout: 10000 }).catch(() => {});
  await r.mark('banner', '#webseal-banner');
  await wait(1200);
  await connect(page);
  await typeAndSend(page, r);
  await r.stop();
  footage.popupTampered = await popupShot(page, 'popup-tampered.png');
  await page.close();
  term('verifyBad', `webseal verify ${ORIGIN} --name ${NAME} --chain sepolia`, webseal('verify', ORIGIN, '--name', NAME, '--chain', 'sepolia'));

  /* the same attack without WebSeal (test wallet only) */
  const N = await browser(false);
  page = await N.ctx.newPage();
  r = recorder('nowebseal', page, null);
  await wait(300);
  await r.mark('goto');
  await page.goto(ORIGIN);
  await wait(1500);
  await connect(page);
  await typeAndSend(page, r);
  footage.nowebsealWallet = await page.evaluate(() => window.__extWalletLog ?? []);
  await r.stop();
  await page.close();

  /* recovery and the source check */
  term('restore', 'pnpm wagmi:restore', wagmi('restore'));
  log('reproduce: clones, installs and builds (about a minute)');
  const rep = wagmi('reproduce', ORIGIN);
  term('reproduce', `pnpm wagmi:reproduce ${ORIGIN}`, rep.split('\n').filter((l) => /^(site|served|anchor|source|commit|build|rebuilt|files|result|error)\b|^\s+(same|DIFFERS|NOT BUILT|NOT LIVE)\b/.test(l)).join('\n'));
  term('verifyOk', `webseal verify ${ORIGIN} --name ${NAME} --chain sepolia`, webseal('verify', ORIGIN, '--name', NAME, '--chain', 'sepolia'));
} finally {
  wagmi('restore');
  for (const c of contexts) await c.close().catch(() => {});
  server?.kill();
  await writeFile(join(OUT, 'footage.json'), JSON.stringify(footage, null, 2));
  log('wrote video-assets/footage/footage.json');
}
