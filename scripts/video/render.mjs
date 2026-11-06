// Renders a canvas video page (scripts/video/*.html) to MP4 with a code-generated soundtrack.
//
//   node scripts/video/render.mjs                      the 2-minute demo (webseal-demo.html, 2560x1440)
//   node scripts/video/render.mjs --short              the 30-second cut (webseal-30s.html, 1920x1080)
//   node scripts/video/render.mjs --stills 3,25.5,60   only these moments, as PNGs in <out>/qa/stills
//   node scripts/video/render.mjs --qa-only            rebuild the QA sheet from the last render
//
// 1. Playwright (headless Chromium) loads the page; drawFrame(t) draws one frame from code and
//    renderAudio() synthesizes the soundtrack offline with Web Audio from the same timeline.
// 2. Frames are rendered by several pages in parallel, captured as PNG, and piped in order into
//    FFmpeg -> H.264. 3. FFmpeg muxes the WAV in as AAC.
// 4. QA: contact sheet (exact frames, timestamped) over the waveform with a red tick per scene,
//    plus one full-size still per scene.
// Needs FFmpeg with libx264 (winget install Gyan.FFmpeg), or FFMPEG=<path>.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { values: opt } = parseArgs({
  options: {
    short: { type: 'boolean', default: false },
    stills: { type: 'string' },
    'qa-only': { type: 'boolean', default: false },
    workers: { type: 'string', default: '4' },
  },
});
const CFG = opt.short
  ? { page: 'webseal-30s.html', W: 1920, H: 1080, duration: 30, name: 'webseal-30s', cols: 6, rows: 5, every: 1 }
  : { page: 'webseal-demo.html', W: 2560, H: 1440, duration: 120, name: 'webseal-demo-2min', cols: 8, rows: 8, every: 2 };
const FPS = 30;
const OUT = join(ROOT, 'video-assets/final');
const QA = join(OUT, `qa-${CFG.name}`);
const final = join(OUT, `${CFG.name}.mp4`);

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const base = join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Packages');
  if (existsSync(base)) for (const d of readdirSync(base).filter((n) => /ffmpeg/i.test(n))) for (const sub of readdirSync(join(base, d))) { const exe = join(base, d, sub, 'bin/ffmpeg.exe'); if (existsSync(exe)) return exe; }
  return 'ffmpeg';
}
const FFMPEG = findFfmpeg();
const ff = (args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
const log = (...a) => console.log('[video]', ...a);
await mkdir(QA, { recursive: true });

let scenes;
if (!opt['qa-only']) {
  const MIME = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
  const server = createServer(async (req, res) => {
    const path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!path.startsWith(ROOT)) return res.writeHead(403).end();
    try { res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' }).end(await readFile(path)); } catch { res.writeHead(404).end(); }
  }).listen(4183);
  const browser = await chromium.launch({ headless: true });
  const open = async () => {
    const p = await browser.newPage({ viewport: { width: CFG.W, height: CFG.H }, deviceScaleFactor: 1 });
    p.on('pageerror', (e) => console.error('[page]', e.message));
    await p.goto(`http://localhost:4183/scripts/video/${CFG.page}`);
    await p.evaluate(() => window.ready);
    return p;
  };
  const shot = (p, t) => p.evaluate((x) => window.drawFrame(x), t).then(() => p.screenshot({ type: 'png', clip: { x: 0, y: 0, width: CFG.W, height: CFG.H } }));
  try {
    const first = await open();
    scenes = await first.evaluate(() => window.SCENES);
    log(`scenes: ${scenes.map((s) => `${s.id} ${s.start.toFixed(1)}-${s.end.toFixed(1)}`).join(' | ')}`);
    if (opt.stills) {
      const dir = join(QA, 'stills');
      await mkdir(dir, { recursive: true });
      for (const t of opt.stills.split(',').map(Number)) await writeFile(join(dir, `t-${t.toFixed(2)}.png`), await shot(first, t));
      log(`stills in ${dir}`);
    } else {
      log('soundtrack: synthesizing offline');
      const { wav, peak } = await first.evaluate(() => window.renderAudio());
      const wavPath = join(OUT, `${CFG.name}.wav`);
      await writeFile(wavPath, Buffer.from(wav, 'base64'));
      log(`soundtrack written (raw peak ${peak.toFixed(3)}, normalized to -1 dBFS)`);

      const pages = [first];
      for (let i = 1; i < Number(opt.workers); i++) pages.push(await open());
      const total = FPS * CFG.duration;
      log(`frames: ${total} at ${CFG.W}x${CFG.H}, ${pages.length} workers, piped to FFmpeg`);
      const videoOnly = join(OUT, `${CFG.name}-video-only.mp4`);
      const enc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-tune', 'animation', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', videoOnly], { stdio: ['pipe', 'inherit', 'inherit'] });
      const done = new Promise((r, j) => enc.on('close', (c) => (c === 0 ? r() : j(new Error(`ffmpeg exited ${c}`)))));
      const t0 = Date.now();
      for (let i = 0; i < total; i += pages.length) {
        const batch = await Promise.all(pages.map((p, k) => (i + k < total ? shot(p, (i + k) / FPS) : null)));
        for (const png of batch) if (png && !enc.stdin.write(png)) await new Promise((r) => enc.stdin.once('drain', r));
        if (i % 300 < pages.length) log(`  frame ${i}/${total} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      }
      enc.stdin.end();
      await done;
      log('mux: video + soundtrack');
      ff(['-i', videoOnly, '-i', wavPath, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', final]);
      await rm(videoOnly, { force: true });
      await writeFile(join(QA, 'scenes.json'), JSON.stringify(scenes, null, 2));
    }
  } finally {
    await browser.close();
    server.close();
  }
} else scenes = JSON.parse(await readFile(join(QA, 'scenes.json'), 'utf8'));

if (!opt.stills) {
  log('QA: contact sheet, waveform, per-scene stills');
  const font = 'C\\:/Windows/Fonts/consola.ttf';
  const TW = 320, PAD = 6, sheetW = 2 * PAD + CFG.cols * TW + (CFG.cols - 1) * PAD;
  ff(['-i', final, '-vf', `select='not(mod(n\\,${FPS * CFG.every}))',drawtext=fontfile='${font}':text='%{pts\\:hms}':x=24:y=24:fontsize=${Math.round(CFG.H / 22)}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=10,scale=${TW}:-2,tile=${CFG.cols}x${CFG.rows}:margin=${PAD}:padding=${PAD}:color=0x333333`,
    '-fps_mode', 'passthrough', '-frames:v', '1', join(QA, 'contact.png')]);
  const ticks = scenes.map((s) => `drawbox=x=${Math.round((s.start / CFG.duration) * sheetW)}:y=0:w=3:h=220:color=0xb00020@1:t=fill`).join(',');
  ff(['-i', final, '-filter_complex', `[0:a]showwavespic=s=${sheetW}x220:colors=0x5b7bff:split_channels=0,${ticks}[w]`, '-map', '[w]', '-frames:v', '1', join(QA, 'waveform.png')]);
  ff(['-i', join(QA, 'contact.png'), '-i', join(QA, 'waveform.png'), '-filter_complex', '[0][1]vstack=inputs=2', join(OUT, `${CFG.name}-contact-sheet.png`)]);
  for (const [i, s] of scenes.entries()) {
    const mid = (s.start + Math.min(s.end, CFG.duration - 0.05)) / 2;
    ff(['-ss', mid.toFixed(2), '-i', final, '-frames:v', '1', join(QA, `scene-${String(i + 1).padStart(2, '0')}-${s.id}.png`)]);
  }
  const probe = execFileSync(FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'), ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,sample_rate,channels:format=duration,bit_rate', '-of', 'default=nw=1', final]).toString();
  log('probe:\n' + probe.trim());
  log(`done: ${final}`);
}
