// Records the whole WebSeal demo as a video, with nobody at the keyboard.
//
//   pnpm demo:record
//       Test wallet (scripts/fixtures/fake-wallet), fully automatic. Writes
//       docs/demo/webseal-demo.webm (about 70 s, 1280x720).
//
//   pnpm demo:record --setup --metamask <unpacked MetaMask dir> --profile .demo-profile
//       Opens a visible Chromium with WebSeal and MetaMask in a dedicated profile.
//       Once: create or import a throwaway wallet, switch it to Sepolia, open the
//       demo tab and press "Connect wallet" and approve. Then close the window.
//
//   MM_PASSWORD=... pnpm demo:record --metamask <dir> --profile .demo-profile
//       Records with real MetaMask: unlocks it, and the MetaMask confirmation
//       window is recorded when it opens on the clean page, then closed (rejected).
//
// Other options: --out <dir> (default docs/demo), --headed, --ens-name <name.eth>,
// --keep-frames (keep the screenshots), --cut-only (re-assemble from kept frames)
// (--ens-name pins the real ENS name instead of the manifest hash; needs a published record).
//
// How it works: every browser page (the dApp, the WebSeal popup, a MetaMask
// window) is captured as a timed sequence of screenshots (about 10 per second).
// scripts/demo-cut.html then plays those sequences in order, with captions and
// terminal cards that show the real output of the commands that ran, and that
// page is recorded as the final video by Playwright in the headless shell.
// (Playwright's own video recording of the full Chromium build, the only one
// that runs extensions, covers the bottom of every frame with a grey band on
// some machines; screenshots and the headless shell's recording do not.)
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, copyFile, rename } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXT = join(ROOT, 'packages/extension/dist');
const DEMO = join(ROOT, 'apps/demo');
const CLI = join(ROOT, 'packages/cli/dist/webseal.js');
const TEST_WALLET = join(ROOT, 'scripts/fixtures/fake-wallet');
const PORT = 4173; // the demo's usual port, so a MetaMask profile set up with `--setup` stays connected
const ORIGIN = `http://localhost:${PORT}`;
const VIEW = { width: 1280, height: 720 };

const { values: opt } = parseArgs({
  options: {
    metamask: { type: 'string' },
    profile: { type: 'string' },
    setup: { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
    out: { type: 'string', default: join(ROOT, 'docs/demo') },
    'ens-name': { type: 'string' },
    'keep-frames': { type: 'boolean', default: false },
    'cut-only': { type: 'boolean', default: false },
  },
});
const OUT = resolve(opt.out);
const CLIPS = join(OUT, '.frames'); // raw screenshot sequences, removed after the cut
const useMetaMask = !!opt.metamask;
if (useMetaMask && !existsSync(join(resolve(opt.metamask), 'manifest.json'))) throw new Error(`--metamask must point to an unpacked MetaMask build (a folder with manifest.json)`);
if ((useMetaMask || opt.setup) && !opt.profile) throw new Error('MetaMask needs a persistent profile: add --profile <dir> (and run --setup once)');
for (const f of [join(EXT, 'manifest.json'), CLI, join(DEMO, 'dist/index.html')]) if (!existsSync(f)) throw new Error(`missing ${relative(ROOT, f)}: run pnpm build first`);

const node = (file, args = []) => execFileSync('node', [file, ...args], { cwd: ROOT, stdio: 'pipe' }).toString();
const exts = [EXT, useMetaMask ? resolve(opt.metamask) : TEST_WALLET].join(',');
const log = (...a) => console.log('[record]', ...a);

/* ---------- the site ---------- */
node(join(DEMO, 'restore.mjs'));
const buildOut = node(CLI, ['build', '--dist', join(DEMO, 'dist'), '--name', opt['ens-name'] ?? 'acme-demo.eth', '--no-commit']);
const HASH = createHash('sha256').update(await readFile(join(DEMO, 'dist/.well-known/webseal.json'))).digest('hex');
const server = spawn('node', [join(DEMO, 'server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const cleanup = async () => {
  server.kill();
  try {
    node(join(DEMO, 'restore.mjs'));
  } catch {}
};

try {
  if (opt.setup) await setup();
  else if (opt['cut-only']) await cut(); // re-assemble from a kept timeline and frames
  else await record();
} finally {
  await cleanup();
}

/* ---------- one-time MetaMask setup ---------- */
async function setup() {
  const ctx = await chromium.launchPersistentContext(resolve(opt.profile), {
    channel: 'chromium',
    headless: false,
    viewport: null,
    args: [`--disable-extensions-except=${exts}`, `--load-extension=${exts}`],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(ORIGIN);
  console.log(`
A Chromium window opened with WebSeal and MetaMask (profile ${opt.profile}).
  1. Finish MetaMask's onboarding: create or import a THROWAWAY wallet. It needs no funds.
  2. In MetaMask, show test networks and switch to Sepolia.
  3. In the demo tab (${ORIGIN}), press "Connect wallet" and approve it in MetaMask.
  4. Close the browser window. Then record with:
     MM_PASSWORD=<the password you chose> pnpm demo:record --metamask ${opt.metamask} --profile ${opt.profile}
`);
  await new Promise((r) => ctx.on('close', r));
}

/* ---------- recording ---------- */
async function record() {
  await rm(CLIPS, { recursive: true, force: true });
  await mkdir(CLIPS, { recursive: true });
  const ctx = await chromium.launchPersistentContext(opt.profile ? resolve(opt.profile) : '', {
    channel: 'chromium',
    headless: !opt.headed,
    viewport: VIEW,
    colorScheme: 'light',
    args: [`--disable-extensions-except=${exts}`, `--load-extension=${exts}`],
  });
  // Find WebSeal's service worker among the extensions'.
  let sw;
  for (let i = 0; i < 40 && !sw; i++) {
    for (const w of ctx.serviceWorkers()) {
      const name = await w.evaluate(() => chrome.runtime.getManifest().name).catch(() => '');
      if (name === 'WebSeal') sw = w;
    }
    if (!sw) await new Promise((r) => setTimeout(r, 250));
  }
  if (!sw) throw new Error('WebSeal did not load');
  const extId = new URL(sw.url()).host;
  for (const p of ctx.pages()) if (!p.url().startsWith('chrome-extension://')) await p.close().catch(() => {}); // blank start page

  // Trust anchor: the ENS name when given, otherwise this build's manifest hash (developer pin).
  const pin = opt['ens-name'] ? { kind: 'ens', name: opt['ens-name'] } : { kind: 'hash', hash: HASH };
  await sw.evaluate(async ([host, p]) => chrome.storage.local.set({ pins: { [host]: p }, settings: { chain: 'sepolia' } }), [`localhost:${PORT}`, pin]);

  if (useMetaMask) await unlockMetaMask(ctx);

  const tabIdFor = (page) =>
    sw.evaluate(async (url) => {
      const tabs = (await chrome.tabs.query({})).filter((t) => t.url?.startsWith(url));
      return tabs.length ? Math.max(...tabs.map((t) => t.id)) : undefined;
    }, page.url().split('#')[0]);
  const badge = (tabId) => sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  const waitBadge = async (tabId, want, ms = 15000) => {
    for (let t = 0; t < ms; t += 250) {
      if ((await badge(tabId)) === want) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };

  const scenes = [];
  let captureN = 0;
  /** Screenshot a page about 10 times a second until stop(); returns the timed frames. */
  function capture(page, clip) {
    const dir = join(CLIPS, String(++captureN).padStart(2, '0'));
    const frames = [];
    const t0 = Date.now();
    let on = true;
    const done = (async () => {
      await mkdir(dir, { recursive: true });
      while (on) {
        const t = Date.now();
        const buf = await page.screenshot({ type: 'jpeg', quality: 82, clip }).catch(() => null);
        if (buf && on) {
          const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`);
          await writeFile(file, buf);
          frames.push({ at: t - t0, file: relative(OUT, file).split(sep).join('/') });
        }
        await new Promise((r) => setTimeout(r, Math.max(0, 100 - (Date.now() - t))));
      }
    })();
    return { t0, stop: async () => ((on = false), await done, frames) };
  }
  const POPUP_CLIP = { x: 0, y: 0, width: 380, height: 720 }; // the popup page is 380 px wide

  /** A scene recorded on one main page, with timed captions and inset clips. */
  async function shoot(title, fn) {
    const page = await ctx.newPage();
    const main = capture(page);
    const t0 = main.t0;
    const cues = [];
    const inserts = [];
    const api = {
      page,
      cue: (text, chip) => cues.push({ at: Date.now() - t0, text, chip }),
      async inset(p, kind, label, holdMs) {
        const c = capture(p, kind === 'popup' ? POPUP_CLIP : undefined);
        const start = c.t0 - t0;
        await p.waitForTimeout(holdMs);
        const frames = await c.stop();
        const end = Date.now() - t0;
        await p.close();
        inserts.push({ frames, kind, label, start, end });
      },
    };
    await fn(api);
    const frames = await main.stop();
    const durationMs = Date.now() - t0;
    await page.close();
    scenes.push({ kind: 'clip', title, main: { frames }, inserts, cues, durationMs });
    log(`shot "${title}" (${(durationMs / 1000).toFixed(1)} s)`);
  }
  const card = (s) => scenes.push({ kind: 'card', durationMs: 3500, ...s });

  const walletSeen = (page) => page.evaluate(() => window.__walletSeen ?? []);
  // The dApp writes every outcome to its log, newest line first; captions are based on it.
  // Lines look like "12:58:44 PM  send failed: …"; drop the time.
  const lastLog = async (page) => ((await page.textContent('#log')) ?? '').split(/\r?\n/)[0].replace(/^[\d:]+(\s?[AP]M)?\s+/i, '').trim();
  const watchWallet = (page) =>
    page.evaluate(() => {
      window.__walletSeen = [];
      window.addEventListener('testwallet:request', (e) => window.__walletSeen.push(e.detail));
    });
  const openPopup = async (tabId) => {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
    await p.waitForTimeout(400);
    return p;
  };
  const metamaskWindow = (ms) =>
    ctx.waitForEvent('page', { predicate: (p) => p.url().includes('notification.html') || p.url().includes('#confirm'), timeout: ms }).catch(() => null);

  /* --- story --- */
  card({
    kicker: 'ETHGlobal · CROPS track',
    title: 'WebSeal',
    lines: [{ text: 'Proves the JavaScript your browser loaded is the build its publisher released, and blocks wallet signing when it is not.', big: true }],
    durationMs: 5000,
  });
  card({
    kicker: 'Release',
    title: 'Build, hash, anchor',
    lines: ['CI hashes every file into a manifest. The manifest hash goes into the ENS text record "webseal".'],
    terminal: { cmd: 'webseal build --dist apps/demo/dist --name acme-demo.eth', output: buildOut },
    durationMs: 5500,
  });

  await shoot('The clean release', async (s) => {
    const { page } = s;
    s.cue('Acme Treasury, a demo dApp. WebSeal hashes every script, style sheet and the HTML it loaded.');
    await page.goto(ORIGIN);
    if (!useMetaMask) await watchWallet(page);
    const tab = await tabIdFor(page);
    await waitBadge(tab, '✓');
    await page.waitForTimeout(1800);
    s.cue(pin.kind === 'ens' ? `Every file matches the release anchored on ${pin.name}. Signing is allowed.` : 'Every file matches the release. Signing is allowed.', 'ok');
    const pop = await openPopup(tab);
    await s.inset(pop, 'popup', 'WebSeal popup', 4500);
    s.cue('Connect the wallet and send 0.01 ETH to the treasury address shown on the page.', 'ok');
    await page.click('#connect');
    await page.waitForTimeout(1500);
    const mmPromise = useMetaMask ? metamaskWindow(15000) : null;
    await page.click('#send');
    if (useMetaMask) {
      const mm = await mmPromise;
      if (mm) {
        s.cue('MetaMask opens its confirmation, as it should on the real release. We reject it.', 'ok');
        await mm.waitForLoadState().catch(() => {});
        await s.inset(mm, 'window', 'MetaMask', 4500); // closing the window rejects the request
      } else s.cue('(MetaMask did not open: check the setup steps.)', 'ok');
    } else {
      await page.waitForTimeout(1200);
      const seen = await walletSeen(page);
      const line = await lastLog(page);
      s.cue(
        seen.includes('eth_sendTransaction') && line.startsWith('sent:')
          ? 'The request reaches the wallet. (A test wallet here; a real wallet would now ask you to confirm.)'
          : `Unexpected: the request did not reach the wallet (${line}).`,
        'ok',
      );
    }
    await page.waitForTimeout(4000);
  });

  card({
    kicker: 'The attack',
    title: 'One file changed on the host',
    lines: ['The repo, the build and the ENS record are untouched. Only the served JavaScript changes: the recipient constant.'],
    terminal: { cmd: 'pnpm demo:tamper', output: node(join(DEMO, 'tamper.mjs')) },
    durationMs: 5500,
  });

  await shoot('After the attack: same URL, reload', async (s) => {
    const { page } = s;
    s.cue('Same page. It still shows the treasury address 0x1111…, but the code now sends to 0xbad0….');
    await page.goto(ORIGIN);
    if (!useMetaMask) await watchWallet(page);
    const tab = await tabIdFor(page);
    await waitBadge(tab, '✗');
    await page.waitForTimeout(1500);
    s.cue('WebSeal finds one file that differs from the release: red banner, signing blocked.', 'fail');
    const pop = await openPopup(tab);
    await s.inset(pop, 'popup', 'WebSeal popup: the changed file', 5000);
    s.cue('Connect still works, and reads still work. Now try to send.', 'fail');
    await page.click('#connect');
    await page.waitForTimeout(1500);
    const mmPromise = useMetaMask ? metamaskWindow(5000) : null;
    await page.click('#send');
    await page.waitForTimeout(2000);
    const opened = useMetaMask ? await mmPromise : null;
    if (opened) await opened.close();
    const seen = useMetaMask ? [] : await walletSeen(page);
    const reached = useMetaMask ? !!opened : seen.includes('eth_sendTransaction');
    const line = await lastLog(page);
    const byWebSeal = /WebSeal blocked this request/.test(line);
    if (reached || !byWebSeal) log(`WARNING: tampered send outcome was not a WebSeal block: ${line}`);
    s.cue(
      reached
        ? 'Unexpected: the request reached the wallet. Check the build.'
        : byWebSeal
          ? `Refused before the wallet ever sees it: "WebSeal blocked this request".${useMetaMask ? ' MetaMask never opens.' : ''}`
          : `Unexpected: the send failed for another reason (${line}).`,
      'fail',
    );
    await page.waitForTimeout(4500);
  });

  card({
    kicker: 'Recovery',
    title: 'Restore the release',
    terminal: { cmd: 'pnpm demo:restore', output: node(join(DEMO, 'restore.mjs')) },
    durationMs: 3000,
  });

  await shoot('Restored', async (s) => {
    const { page } = s;
    await page.goto(ORIGIN);
    const tab = await tabIdFor(page);
    await waitBadge(tab, '✓');
    s.cue('Back to the released build: verified again.', 'ok');
    await page.waitForTimeout(3500);
  });

  card({
    kicker: 'Why this matters',
    title: 'February 2025',
    lines: [
      { text: 'One JavaScript file on Safe{Wallet}’s host was changed while the repo stayed clean. Bybit’s signers approved what looked like a routine transfer and lost about $1.5B.', big: true },
      'WebSeal checks for exactly that change, on every page load, and refuses the signature.',
    ],
    durationMs: 8000,
  });

  await ctx.close();
  await writeFile(join(OUT, 'timeline.json'), JSON.stringify({ scenes }, null, 2));
  await copyFile(join(ROOT, 'scripts/demo-cut.html'), join(OUT, 'demo-cut.html'));
  log(`${scenes.length} scenes, clips in ${relative(ROOT, CLIPS)}`);
  await cut();
}

/* ---------- MetaMask unlock (untested without a set-up profile) ---------- */
async function unlockMetaMask(ctx) {
  const pw = process.env.MM_PASSWORD;
  if (!pw) throw new Error('set MM_PASSWORD to the MetaMask password chosen during --setup');
  let id;
  for (let i = 0; i < 40 && !id; i++) {
    for (const w of ctx.serviceWorkers()) {
      const name = await w.evaluate(() => chrome.runtime.getManifest().name).catch(() => '');
      if (/metamask/i.test(name)) id = new URL(w.url()).host;
    }
    if (!id) await new Promise((r) => setTimeout(r, 250));
  }
  if (!id) throw new Error('MetaMask did not load');
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${id}/home.html`);
  const field = p.locator('[data-testid="unlock-password"]');
  if (await field.isVisible({ timeout: 8000 }).catch(() => false)) {
    await field.fill(pw);
    await p.locator('[data-testid="unlock-submit"]').click();
    await p.waitForTimeout(2000);
  }
  await p.close();
}

/* ---------- final cut: play the timeline in demo-cut.html and record it ---------- */
async function cut() {
  const MIME = { '.html': 'text/html', '.json': 'application/json', '.jpg': 'image/jpeg' };
  const srv = createServer(async (req, res) => {
    const path = join(OUT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!path.startsWith(OUT)) return res.writeHead(403).end();
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'accept-ranges': 'bytes' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  }).listen(4181);
  const tmp = join(OUT, '.cut');
  await rm(tmp, { recursive: true, force: true });
  const browser = await chromium.launch({ headless: true }); // headless shell: records full frames
  const ctx = await browser.newContext({ viewport: VIEW, recordVideo: { dir: tmp, size: VIEW } });
  const page = await ctx.newPage();
  await page.goto('http://localhost:4181/demo-cut.html');
  log('assembling the final cut (plays in real time)…');
  await page.waitForFunction(() => window.__done === true, null, { timeout: 15 * 60_000, polling: 1000 });
  const video = page.video();
  await ctx.close();
  await browser.close();
  srv.close();
  const final = join(OUT, 'webseal-demo.webm');
  await rm(final, { force: true });
  await rename(await video.path(), final);
  await rm(tmp, { recursive: true, force: true });
  if (!opt['keep-frames']) {
    // Without the frames, the timeline and the cut page cannot replay: keep only the video.
    for (const p of [CLIPS, join(OUT, 'timeline.json'), join(OUT, 'demo-cut.html')]) await rm(p, { recursive: true, force: true });
  }
  log(`done: ${relative(ROOT, final)}`);
}
