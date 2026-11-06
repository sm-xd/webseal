// Records the 60-second pitch video from scripts/promo/promo.html, which uses the real
// screenshots in docs/screenshots (run `pnpm screenshots` first).
//
//   node scripts/promo-video.mjs            -> docs/demo/webseal-pitch-60s.webm (1920x1080)
//   node scripts/promo-video.mjs --stills   -> one PNG per scene in docs/demo/pitch-stills, to review
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'docs/demo');
const VIEW = { width: 1920, height: 1080 };
const stills = process.argv.includes('--stills');

const MIME = { '.html': 'text/html', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!path.startsWith(ROOT)) return res.writeHead(403).end();
  try {
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' }).end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
}).listen(4182);
const URL_ = 'http://localhost:4182/scripts/promo/promo.html';

// the headless shell records full frames (the full Chromium build adds a grey band on some machines)
const browser = await chromium.launch({ headless: true });
await mkdir(OUT, { recursive: true });
try {
  if (stills) {
    const dir = join(OUT, 'pitch-stills');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const page = await browser.newPage({ viewport: VIEW });
    await page.goto(URL_);
    await page.evaluate(() => window.ready);
    const n = await page.evaluate(() => document.querySelectorAll('.scene').length);
    for (let i = 0; i < n; i++) {
      await page.evaluate((k) => {
        document.querySelectorAll('.scene').forEach((s, j) => s.classList.toggle('on', j === k));
        document.querySelectorAll('.late').forEach((l) => l.classList.add('on'));
        document.querySelectorAll('.frame img').forEach((img) => (img.style.animation = 'none'));
      }, i);
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(dir, `scene-${i + 1}.png`) });
    }
    console.log(`${n} stills in docs/demo/pitch-stills`);
  } else {
    const tmp = join(OUT, '.pitch');
    await rm(tmp, { recursive: true, force: true });
    const ctx = await browser.newContext({ viewport: VIEW, recordVideo: { dir: tmp, size: VIEW } });
    const page = await ctx.newPage();
    await page.goto(URL_);
    await page.evaluate(() => window.ready);
    const total = await page.evaluate(() => window.total);
    console.log(`recording ${total} s in real time…`);
    await page.evaluate(() => window.play());
    await page.waitForFunction(() => window.__done === true, null, { timeout: (total + 30) * 1000, polling: 500 });
    await page.waitForTimeout(300);
    const video = page.video();
    await ctx.close();
    const final = join(OUT, 'webseal-pitch-60s.webm');
    await rm(final, { force: true });
    await rename(await video.path(), final);
    await rm(tmp, { recursive: true, force: true });
    console.log('done: docs/demo/webseal-pitch-60s.webm');
  }
} finally {
  await browser.close();
  server.close();
}
