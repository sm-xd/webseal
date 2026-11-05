// One command demo on your own machine:
//   builds everything, writes the manifest, serves the demo, and opens Chrome
//   with the WebSeal extension loaded in a separate profile under .chrome-profile/.
// The profile persists, so install MetaMask into it once and it stays.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platform, env } from 'node:process';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const EXT = join(ROOT, 'packages/extension/dist');
const DEMO = join(ROOT, 'apps/demo');
const CLI = join(ROOT, 'packages/cli/dist/webseal.js');
const PROFILE = join(ROOT, '.chrome-profile');
const PORT = Number(env.PORT ?? 4173);
const URL_ = `http://localhost:${PORT}`;

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: platform === 'win32', ...opts });

if (!env.SKIP_BUILD) {
  console.log('\n> building (pnpm build)');
  sh('pnpm', ['build']);
}
console.log('\n> writing manifest');
sh('node', [CLI, 'build', '--dist', join(DEMO, 'dist'), '--name', env.WEBSEAL_ENS_NAME ?? 'acme-demo.eth']);

console.log(`\n> serving demo at ${URL_}`);
const server = spawn('node', [join(DEMO, 'server.mjs')], { env: { ...env, PORT: String(PORT) }, stdio: 'inherit' });

function findChrome() {
  if (env.CHROME) return env.CHROME;
  const candidates =
    platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ]
      : platform === 'win32'
        ? [
            join(env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
            join(env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
            join(env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
          ]
        : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser'];
  for (const c of candidates) {
    if (platform === 'linux') {
      try {
        execFileSync('which', [c], { stdio: 'ignore' });
        return c;
      } catch {}
    } else if (existsSync(c)) return c;
  }
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.log(`
Chrome not found automatically. Either set CHROME=/path/to/chrome and rerun, or:
  1. open chrome://extensions, enable Developer mode, Load unpacked -> ${EXT}
  2. open ${URL_}`);
} else {
  console.log(`\n> launching ${chrome} with the extension (profile: ${PROFILE})`);
  spawn(chrome, [`--user-data-dir=${PROFILE}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check', URL_], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

console.log(`
Next, in the browser:
  1. If this profile has no wallet yet, install MetaMask from the Chrome Web Store and switch it to Sepolia.
  2. Click the WebSeal icon and press "Pin current manifest hash" (or "Pin ENS name" if you published the record).
     The badge turns green.
  3. Connect the wallet, click "Send 0.01 ETH": MetaMask opens its confirmation. Reject it.
  4. In another terminal:  pnpm demo:tamper   then reload the page.
     Red banner, red badge, "Send 0.01 ETH" is refused before MetaMask opens.
  5. pnpm demo:restore and reload: green again.

Ctrl+C here stops the demo server.
`);

process.on('SIGINT', () => {
  server.kill();
  process.exit(0);
});
