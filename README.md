# WebSeal

**Verify that the frontend you loaded is the one its publisher released. Block wallet signing when it is not.**

In February 2025, attackers changed one JavaScript file on the server that hosts the Safe{Wallet} web app. The repo was clean, the contracts were fine, the hardware wallets worked. Bybit's signers approved what looked like a routine transfer and lost about $1.5B. Nothing compared the bytes running in the browser with the bytes the project meant to ship.

WebSeal makes that comparison on every page load.

```
  build (CI)                     browser
  ──────────                     ───────
  hash every file  ──► manifest  ◄── hash every loaded script, style, html
  hash manifest    ──► ENS text record  ◄── resolve record, compare
                                        └─► mismatch: red banner, signing blocked
```

The ENS name is the root of trust. Writing its record needs a wallet signature and is public and timestamped. An attacker with write access to the hosting bucket, as in the Bybit case, has no way to update it.

## Repository

| Path | What |
|---|---|
| `packages/core` | Manifest format, canonical JSON, SHA-256, verification logic. Shared by CLI and extension. |
| `packages/cli` | `webseal build`, `publish`, `record`, `verify`. |
| `packages/extension` | Chrome extension (Manifest V3). Verifier, wallet gate, popup. |
| `apps/demo` | A small dApp that sends ETH to a treasury, a static server, and a tamper script. |
| `scripts/` | End-to-end tests: CLI only, and in Chromium with the extension loaded. |
| `.github/workflows/release.yml` | Build, write manifest, anchor the hash on ENS from CI. |

## Quick start

```bash
pnpm install
pnpm build
pnpm test        # unit tests for core
pnpm e2e         # CLI: build, serve, verify, tamper, verify fails
pnpm e2e:browser   # same in Chromium with the extension, plus bypass attempts (npx playwright install chromium once)
pnpm demo:record   # records the whole demo as docs/demo/webseal-demo.webm, no human needed
```

### One command

```bash
pnpm demo
```

Builds, writes the manifest, serves the site and opens Chromium with the extension loaded in a separate profile. Google Chrome 137 and later ignore `--load-extension`, so the script uses Playwright's Chromium when it is installed; with Google Chrome, load `packages/extension/dist` once via chrome://extensions → Load unpacked (the profile keeps it). See `docs/TESTING.md` for the full checklist, including the real-wallet and ENS steps.

### Record the demo video

```bash
pnpm demo:record
```

Drives Chromium with WebSeal and a test wallet through the whole story (clean page and send, the attack, the red banner and the refused send, restore), captures every page, and assembles a captioned 1280x720 video with title and terminal cards that show the real command output: `docs/demo/webseal-demo.webm`. Captions are written from what actually happened on the page (the dApp's log, the wallet's received requests). For the same video with real MetaMask, see `docs/TESTING.md` §5.

### Run the demo by hand

1. Build and write the manifest:
   ```bash
   pnpm build
   node packages/cli/dist/webseal.js build --dist apps/demo/dist --name acme-demo.eth
   ```
   The last line prints the ENS record value, `v1:sha256:<hash>`.
2. Serve the site: `pnpm demo:serve` (http://localhost:4173).
3. Load `packages/extension/dist` as an unpacked extension in Chrome (`chrome://extensions`, Developer mode, Load unpacked).
4. Open the site, click the WebSeal icon, and either
   - **Pin ENS name** if you published the record (see below), or
   - **Pin current manifest hash** to trust what the server serves right now (developer mode, no chain needed).
   The badge turns green.
5. Attack: `pnpm demo:tamper`. This edits one line in a served JavaScript file, swapping the treasury address the transaction goes to. The address shown on the page does not change.
6. Reload. Red banner, badge turns red, the popup names the changed file, and "Send 0.01 ETH" is refused by the wallet gate before the wallet ever sees it.
7. `pnpm demo:restore` and reload: green again.

### Anchor on ENS

Register a name on Sepolia (https://sepolia.app.ens.domains) and run:

```bash
export WEBSEAL_PRIVATE_KEY=0x...        # key allowed to set the record
node packages/cli/dist/webseal.js publish --name acme-demo.eth --chain sepolia
node packages/cli/dist/webseal.js record  --name acme-demo.eth --chain sepolia
node packages/cli/dist/webseal.js verify http://localhost:4173 --name acme-demo.eth --chain sepolia
```

The extension looks up the `webseal` text record on the pinned name, then on `webseal.<name>` if the first is empty. That second lookup is the limited-rights pattern: let the CI key own only the subname, so a leaked CI key can publish a bad hash and nothing else. On ENSv2, per-record access control gives the same result on the parent name directly.

During a release the record may list two hashes, `v1:sha256:<new>,<old>`: `webseal publish --keep-current` adds the new build next to the current one before the deploy, and a second `publish` without the flag (after the live site serves the new build) drops the old one. Visitors never see red in between. Without a custom RPC, the extension and the CLI read ENS through several public RPCs in turn.

Hosts of the form `app.eth.limo` or `app.eth.link` are derived automatically; any other host must be pinned once from the popup. A derived name that has no `webseal` record has not opted in and is treated as an unknown site (grey), not as a failure. The CLI's `record` and `verify --name` use the same name-then-subname lookup as the extension.

## How verification works

1. `main.js` runs in the page's own world, in every frame, before any page script. It installs an accessor on `window.ethereum` and on wallet-specific globals (`window.phantom.ethereum`, `window.coinbaseWalletExtension` and others) and re-announces EIP-6963 providers, wrapped so that signing methods (`eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v4`, and the rest) wait for a verdict and are refused on failure. Read-only calls and connecting are never blocked. The page's own code is assumed hostile: the wrapper only uses built-ins it captured before page code ran, reads each request's method once and passes a copy on, refuses to let the page replace provider methods, and never hands the raw provider out (callbacks get the wrapper as `this`; methods that return the provider return the wrapper).
2. `content.js` (isolated world) asks the service worker for the host's anchor, fetches `/.well-known/webseal.json`, hashes it, and compares it with the anchored value. Then it hashes the HTML document the page was loaded from, every same-origin script and stylesheet, WebAssembly the page fetches, and the scripts of the origin's service workers, and compares each with the manifest. A client-side route such as `/dashboard` passes when its HTML is byte-identical to a release page. Any file that differs, any file not in the manifest, any inline script not in the manifest's allow-list, and any cross-origin script is a failure.
3. Scripts and stylesheets added after load (dynamic imports, injected tags) are checked incrementally; ordinary `fetch`/XHR traffic such as RPC polling does not trigger anything. A page can go from green to red, never the other way without a reload: the popup's Re-check re-verifies in place but keeps a failed page failed, since its code already ran.
4. Frames and windows: a same-origin subframe (including `about:blank`, `srcdoc` and `blob:` frames) and a window opened by a same-origin page can be reached by the other page's code, so each takes the worse of its own verdict and the related page's, and a failure in either fails both. A same-origin frame registers with the top page synchronously, before any of its own scripts run, and the top page holds signing until that frame is verified; a frame that disappears before it is verified fails the page, since it could have planted code there.
5. The verdict reaches the page world over a private channel: `main.js` creates a detached `<webseal-channel>` element that `content.js` takes out of the document in the same injection step, before any page script runs. The status is the event type dispatched on that element, so page code can neither observe nor forge it. Per-tab results live in `chrome.storage.session`, so the popup survives the service worker being stopped.

Unknown sites (no pin, no derivable name, or a derived name without a record) are grey and nothing is blocked, so the extension does not break the rest of the web.

## What this does not protect against

- **A poisoned source repository.** If malicious code is merged, CI builds and anchors it faithfully. WebSeal proves you are running what was released, not that the release is safe. Reproducible builds and review are the complement.
- **A server that lies selectively.** The extension re-fetches each file (from the browser cache where possible) to hash it. A server that serves clean bytes to the re-fetch and poisoned bytes to the page would evade it. The Bybit and Ledger attacks were persistent file changes, not per-request games. A stronger version would hash real response bodies via the debugger API or Firefox's response filter.
- **Web workers' own imports, and WebAssembly fetched from a URL not ending in `.wasm`,** are not collected.
- **Wallet-specific globals.** The gate wraps `window.ethereum`, `ethereum.providers` and EIP-6963 providers. Known wallet globals are wrapped too, but a wallet with a global that is not on the list, or one whose methods return internal objects, can still be reached unwrapped by page code. Non-EVM providers (for example Solana's) are not gated. Closing this for good needs the wallet itself to ask WebSeal for the verdict.
- **The ENS lookup itself** goes over an RPC. A lying RPC could return a bad record. Pinning the hash, or reading through a light client, closes that.
- **Users without the extension.** The build step could also emit Subresource Integrity attributes so browsers enforce part of the check with no extension.

## Manifest format

```json
{
  "version": 1,
  "name": "acme-demo.eth",
  "commit": "<git sha>",
  "files": { "/index.html": "<sha256>", "/assets/index-abc.js": "<sha256>" },
  "inline": ["<sha256 of an allowed inline script body>"]
}
```

Served at `/.well-known/webseal.json`, encoded as canonical JSON (sorted keys, no whitespace). The ENS record is `v1:sha256:<sha256 of the manifest bytes>`.

## License

MIT
