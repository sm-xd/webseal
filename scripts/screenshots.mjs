// Runs the whole WebSeal flow on the wagmi app against the live Sepolia record and saves
// a numbered screenshot of every step: CLI output, the web app, the WebSeal popup and
// extension page, and what the wallet was asked to sign.
//
//   node scripts/screenshots.mjs [--out docs/screenshots] [--no-reproduce] [--headed]
//
// Needs: pnpm build, pnpm wagmi:build, and the wagmi build's hash in the smxreds.eth record
// (WEBSEAL_ENS_NAME to use another name). The wallet is the test wallet in
// scripts/fixtures/fake-wallet: no keys, nothing is sent. MetaMask screenshots are manual
// (docs/TESTING.md).
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXT = join(ROOT, 'packages/extension/dist');
const WALLET = join(ROOT, 'scripts/fixtures/fake-wallet');
const CLI = join(ROOT, 'packages/cli/dist/webseal.js');
const DIST = join(ROOT, 'apps/wagmi-playground/dist');
const NAME = process.env.WEBSEAL_ENS_NAME ?? 'smxreds.eth';
const REPO = process.env.WEBSEAL_REPO ?? 'https://github.com/sm-xd/webseal.git';
const PORT = Number(process.env.PORT ?? 4174);
const ORIGIN = `http://localhost:${PORT}`;
const RECIPIENT = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'; // the test wallet's own account: "send to yourself"

const { values: opt } = parseArgs({
  options: {
    out: { type: 'string', default: join(ROOT, 'docs/screenshots') },
    reproduce: { type: 'boolean', default: true },
    headed: { type: 'boolean', default: false },
    scale: { type: 'string', default: '1' }, // device pixel ratio: 2 for sharp frames in a 1080p video
    dark: { type: 'boolean', default: false }, // dark color scheme (the wagmi skin and the popup both follow it)
  },
  allowNegative: true,
});
const OUT = resolve(opt.out);
await mkdir(OUT, { recursive: true });
// A fresh set every run: drop the numbered files of the last one (MetaMask's mm-* are kept).
for (const f of await readdir(OUT)) if (/^\d\d-.*\.png$/.test(f)) await rm(join(OUT, f));
const saved = [];
const log = (...a) => console.log('[shots]', ...a);
// Files are numbered in the order they are taken: 01-…, 02-…
let count = 0;
const numbered = (name) => `${String(++count).padStart(2, '0')}-${name}`;

/* ---------- commands ---------- */
const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
/** Runs a command and returns everything it printed, also when it exits non-zero (verify FAILED). */
function run(file, args) {
  try {
    return strip(execFileSync('node', [file, ...args], { cwd: ROOT, stdio: 'pipe', maxBuffer: 64 << 20 }).toString());
  } catch (e) {
    return strip(`${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
}
const webseal = (...args) => run(CLI, args);
const wagmi = (...args) => run(join(ROOT, 'scripts/wagmi.mjs'), args);
/** reproduce prints the whole install and build; keep its own report lines. */
const reproduceReport = (out) =>
  out
    .split('\n')
    .filter((l) => /^(site|served|anchor|source|commit|build|rebuilt|files|result|error)\b|^\s+(same|DIFFERS|NOT BUILT|NOT LIVE)\b/.test(l))
    .join('\n');

/* ---------- terminal and card images ---------- */
const term = await chromium.launch();
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const paint = (s) =>
  esc(s)
    .replace(/\b(VERIFIED|REPRODUCED[^\n]*|ok|same|success|readback ok)\b/g, '<b class="g">$1</b>')
    .replace(/\b(FAILED|MISMATCH|DIFFERS|DIFFERENT[^\n]*|NOT anchored|tampered|warning)\b/g, '<b class="r">$1</b>')
    .replace(/(0xbad0000000000000000000000000000000000bad)/g, '<b class="r">$1</b>');
async function image(name, title, body) {
  const file = numbered(name);
  const page = await term.newPage({ viewport: { width: 1100, height: 200 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#e8eaed;padding:24px;font:14px/1.5 ui-monospace,'Cascadia Mono',Consolas,monospace}
    .w{border:2px solid #101114;background:#0b0c0e;color:#eceef2}
    .t{background:#101114;color:#9aa0ab;padding:8px 14px;font:600 12px/1 ui-sans-serif,system-ui,'Segoe UI',sans-serif;letter-spacing:.06em;text-transform:uppercase;border-bottom:2px solid #2a2d33}
    pre{margin:0;padding:16px 18px;white-space:pre-wrap;word-break:break-all}
    .p{color:#5b7bff} .g{color:#4ade80;font-weight:600} .r{color:#ff6b6b;font-weight:700}
  </style><div class="w"><div class="t">${esc(title)}</div><pre>${body}</pre></div>`);
  await page.locator('.w').screenshot({ path: join(OUT, file) });
  await page.close();
  saved.push(file);
  log(file);
}
const terminal = (file, cmd, output) => image(file, 'terminal', `<span class="p">PS Z:\\ethmumbai&gt;</span> ${esc(cmd)}\n${paint(output.trimEnd())}`);
function walletCard(file, title, entries) {
  const sends = entries.filter((e) => e.method === 'eth_sendTransaction');
  const lines = sends.length
    ? sends.map((e) => {
        const tx = e.params?.[0] ?? {};
        const wei = tx.value ? BigInt(tx.value) : 0n;
        const eth = `${wei / 10n ** 18n}.${(wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '') || '0'}`;
        return `eth_sendTransaction\n  from   ${tx.from}\n  to     ${tx.to}\n  value  ${eth} ETH`;
      })
    : ['eth_sendTransaction   never received'];
  const other = entries.map((e) => e.method).filter((m) => m !== 'eth_sendTransaction');
  const body = `${lines.join('\n\n')}\n\nother requests: ${[...new Set(other)].join(', ') || 'none'}`;
  return image(file, title, paint(body));
}

/* ---------- the site ---------- */
wagmi('restore');
let server;
const up = await fetch(ORIGIN).then((r) => r.ok, () => false);
if (!up) {
  server = spawn('node', [join(ROOT, 'apps/demo/server.mjs')], { env: { ...process.env, PORT: String(PORT), WEBSEAL_DEMO_DIST: DIST }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 700));
}

const contexts = [];
async function browser(withWebSeal) {
  const exts = withWebSeal ? `${EXT},${WALLET}` : WALLET;
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !opt.headed,
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: Number(opt.scale),
    colorScheme: opt.dark ? 'dark' : 'light',
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
  if (!sw) throw new Error('WebSeal did not load');
  await sw.evaluate(async ([host, name]) => chrome.storage.local.set({ pins: { [host]: { kind: 'ens', name } }, settings: { chain: 'sepolia' } }), [`localhost:${PORT}`, NAME]);
  return { ctx, sw, extId: new URL(sw.url()).host };
}

const shot = async (page, name, opts = {}) => {
  const file = numbered(name);
  await (opts.locator ?? page).screenshot({ path: join(OUT, file), ...(opts.locator ? {} : { fullPage: opts.fullPage ?? true }) });
  saved.push(file);
  log(file);
};
const sendCell = (page) => page.locator('#root > div', { has: page.locator('input[name="address"]') });
const walletLog = (page) => page.evaluate(() => window.__extWalletLog ?? []);
async function connect(page) {
  const disconnect = page.getByRole('button', { name: 'Disconnect' });
  if (await disconnect.isVisible().catch(() => false)) return;
  await page.getByRole('button', { name: 'Test Wallet' }).click();
  await disconnect.waitFor({ timeout: 10000 });
}
async function fillSend(page) {
  const cell = sendCell(page);
  await cell.locator('input[name="address"]').fill(RECIPIENT);
  await cell.locator('input[name="value"]').fill('0.0001');
}
async function send(page) {
  const cell = sendCell(page);
  await cell.locator('button[type="submit"]').click();
  await cell.getByText(/Transaction Hash|Error/).waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
}

try {
  /* 1. release: build, anchor, check */
  // Rebuilding the manifest records HEAD: only do it when HEAD is the commit the anchored build came from.
  const manifestFile = join(DIST, '.well-known/webseal.json');
  const served = JSON.parse(await readFile(manifestFile, 'utf8'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
  let hash;
  if (served.commit === head) {
    const build = webseal('build', '--dist', 'apps/wagmi-playground/dist', '--name', NAME, '--repo', REPO);
    await terminal('cli-build-manifest.png', `webseal build --dist apps/wagmi-playground/dist --name ${NAME} --repo ${REPO}`, build);
    hash = /hash\s+([0-9a-f]{64})/.exec(build)?.[1];
  } else {
    hash = createHash('sha256').update(await readFile(manifestFile)).digest('hex');
    await terminal('cli-build-manifest.png', 'Get-Content apps/wagmi-playground/dist/.well-known/webseal.json', `${JSON.stringify(served, null, 2)}\n\nsha256 of these bytes: ${hash}`);
  }
  const record = webseal('record', '--name', NAME, '--chain', 'sepolia');
  await terminal('cli-ens-record.png', `webseal record --name ${NAME} --chain sepolia`, record);
  if (hash && !record.includes(hash)) log(`WARNING: ${hash} is not in the ${NAME} record: the clean shots will be red. Publish it first.`);
  await terminal('cli-ens-writers.png', `webseal writers --name ${NAME} --chain sepolia`, webseal('writers', '--name', NAME, '--chain', 'sepolia'));
  await terminal('cli-verify-clean.png', `webseal verify ${ORIGIN} --name ${NAME} --chain sepolia`, webseal('verify', ORIGIN, '--name', NAME, '--chain', 'sepolia'));

  /* 2. the clean site, with WebSeal */
  const W = await browser(true);
  const tabId = (page) =>
    W.sw.evaluate(async (url) => {
      const tabs = (await chrome.tabs.query({})).filter((t) => t.url?.startsWith(url));
      return tabs.length ? Math.max(...tabs.map((t) => t.id)) : undefined;
    }, page.url().split('#')[0]);
  const waitBadge = async (page, want) => {
    const id = await tabId(page);
    for (let t = 0; t < 20000; t += 250) {
      if ((await W.sw.evaluate((i) => chrome.action.getBadgeText({ tabId: i }), id)) === want) return true;
      await page.waitForTimeout(250);
    }
    log(`WARNING: badge never showed ${want}`);
    return false;
  };
  const popup = async (page, file) => {
    const id = await tabId(page);
    const p = await W.ctx.newPage();
    await p.setViewportSize({ width: 380, height: 600 });
    await p.goto(`chrome-extension://${W.extId}/popup.html?tab=${id}`);
    await p.waitForTimeout(800);
    await shot(p, file);
    if (file === 'ext-popup-verified.png') await shot(p, 'ext-popup-writers-row.png', { locator: p.locator('#writersRow') });
    await p.close();
  };

  const extPage = await W.ctx.newPage();
  await extPage.goto('chrome://extensions');
  await extPage.waitForTimeout(800);
  await shot(extPage, 'ext-installed.png', { fullPage: false });
  await extPage.close();

  let page = await W.ctx.newPage();
  await page.goto(ORIGIN);
  await waitBadge(page, '✓');
  await page.waitForTimeout(1200);
  await shot(page, 'web-clean-verified.png');
  await popup(page, 'ext-popup-verified.png');
  await connect(page); // the test wallet is already authorized, so wagmi has usually reconnected by itself
  await fillSend(page);
  await shot(page, 'web-send-form.png', { locator: sendCell(page) });
  await send(page);
  await shot(page, 'web-send-reached-wallet.png', { locator: sendCell(page) });
  await walletCard('wallet-request-clean.png', 'test wallet: what the page asked it to sign (clean release)', await walletLog(page));
  await page.close();

  /* 3. the attack */
  await terminal('cli-tamper.png', 'pnpm wagmi:tamper', wagmi('tamper'));
  page = await W.ctx.newPage();
  await page.goto(ORIGIN);
  await waitBadge(page, '✗');
  await page.waitForTimeout(1200);
  await shot(page, 'web-tampered-banner.png', { fullPage: false });
  await shot(page, 'web-tampered-full.png');
  await popup(page, 'ext-popup-tampered.png');
  await connect(page);
  await fillSend(page);
  await send(page);
  // The banner says why; wagmi's own error text is the generic 4100 message.
  await sendCell(page).scrollIntoViewIfNeeded();
  await shot(page, 'web-send-blocked-with-banner.png', { fullPage: false });
  await shot(page, 'web-send-blocked.png', { locator: sendCell(page) });
  await walletCard('wallet-request-tampered-blocked.png', 'test wallet: what the page asked it to sign (tampered, WebSeal on)', await walletLog(page));
  await page.close();
  await terminal('cli-verify-tampered.png', `webseal verify ${ORIGIN} --name ${NAME} --chain sepolia`, webseal('verify', ORIGIN, '--name', NAME, '--chain', 'sepolia'));
  if (opt.reproduce) {
    log('reproduce (tampered): clones, installs and builds, about a minute');
    await terminal('cli-reproduce-tampered.png', `pnpm wagmi:reproduce ${ORIGIN}`, reproduceReport(wagmi('reproduce', ORIGIN)));
  }

  /* 4. the same attack without WebSeal: what the user would have signed */
  const N = await browser(false);
  page = await N.ctx.newPage();
  await page.goto(ORIGIN);
  await page.waitForTimeout(1500);
  await connect(page);
  await fillSend(page);
  await shot(page, 'web-no-webseal-tampered-form.png', { locator: sendCell(page) });
  await send(page);
  await shot(page, 'web-no-webseal-sent.png', { locator: sendCell(page) });
  await walletCard('wallet-request-no-webseal.png', 'test wallet: what the page asked it to sign (tampered, NO WebSeal)', await walletLog(page));
  await page.close();

  /* 5. recovery */
  await terminal('cli-restore.png', 'pnpm wagmi:restore', wagmi('restore'));
  page = await W.ctx.newPage();
  await page.goto(ORIGIN);
  await waitBadge(page, '✓');
  await page.waitForTimeout(1000);
  await shot(page, 'web-restored-verified.png', { fullPage: false });
  await popup(page, 'ext-popup-restored.png');
  await page.close();
  await terminal('cli-verify-restored.png', `webseal verify ${ORIGIN} --name ${NAME} --chain sepolia`, webseal('verify', ORIGIN, '--name', NAME, '--chain', 'sepolia'));
  if (opt.reproduce) {
    log('reproduce (clean): clones, installs and builds, about a minute');
    await terminal('cli-reproduce-clean.png', `pnpm wagmi:reproduce ${ORIGIN}`, reproduceReport(wagmi('reproduce', ORIGIN)));
  }
} finally {
  wagmi('restore');
  for (const c of contexts) await c.close().catch(() => {});
  await term.close();
  server?.kill();
}
log(`${saved.length} screenshots in ${relative(ROOT, OUT) || OUT}`);
