# WebSeal handoff

Context for a Claude Code session continuing this work on a local machine.

## What this is

WebSeal is a hackathon MVP (ETHGlobal, Ethereum Foundation CROPS track, with an ENS angle): a frontend integrity checker. It proves that the JavaScript a browser loaded for a dApp is the build its publisher released, and blocks wallet signing when it is not. Motivation: the February 2025 Bybit theft, where one JavaScript file on Safe{Wallet}'s hosting was changed while the repo stayed clean.

Trust chain: CI hashes every build file into a manifest, and the manifest's SHA-256 is written to an ENS text record (`webseal` = `v1:sha256:<hex>`). A Chrome extension resolves the record, fetches `/.well-known/webseal.json`, checks its hash, then hashes every loaded same-origin script, stylesheet and the HTML and compares. Mismatch, unlisted file, unlisted inline script or cross-origin script = red banner + wallet signing refused.

## Layout (pnpm workspace, Node 22, TypeScript, esbuild, viem)

- `packages/core/src/index.ts`: manifest format, canonical JSON, sha256, `normalizePath`, `verifyFiles`, `verifyInline`, `extractInlineScripts`, `SIGNING_METHODS`. Tests in `packages/core/test`.
- `packages/cli`: `webseal build|publish|record|verify`. Bundled to `packages/cli/dist/webseal.js`. ENS read/write in `src/ens.ts` (viem `getEnsText`, PublicResolver `setText`). Chains: `sepolia` (default), `mainnet`.
- `packages/extension` (Manifest V3, loads from `packages/extension/dist`):
  - `src/main.ts`: MAIN-world script at document_start, in every frame. Wraps `window.ethereum` via accessor + Proxy, `ethereum.providers`, and re-announces EIP-6963 providers wrapped. Signing methods wait for a verdict (20 s timeout) and reject with code 4100 on failure. Written against a hostile page: only built-ins captured before page code ran, request args read once and copied, provider methods cannot be replaced, the raw provider never leaks (callbacks get the proxy as `this`, `on()` returns the proxy), `fail` is sticky until reload. The verdict arrives on a private channel (`src/channel.ts`): a detached `<webseal-channel>` element that content.ts removes from the document before any page script runs; the status is the event type.
  - `src/content.ts`: isolated-world verifier, every frame. Gets the anchor from the service worker, verifies after `load` (the document by its original URL, so SPA routes pass when the HTML equals a release page), re-verifies incrementally on new scripts/links only (fetch/XHR ignored). Same-origin subframes (incl. about:blank/srcdoc, compared by `window.origin`) and windows opened by a same-origin page take the worse of their own and the related page's verdict; a failure in one fails the other. Popup Re-check re-verifies in place but never turns a failed page green. Red banner in a closed shadow root, escaped, re-attached if removed.
  - `src/background.ts`: anchor lookup (pinned ENS name, pinned hash, or derived from `*.eth.limo`/`*.eth.link` hosts; a derived name with no record is unknown, a failed lookup fails closed), ENS resolution with fallback to `webseal.<name>`, per-tab state in `chrome.storage.session` (survives service-worker restarts), verdict broadcast to subframes and opened windows, per-tab badge (✓ green, ✗ red, … pending, blank unknown).
  - `src/popup.*`: status, per-file list, "Pin ENS name", "Pin current manifest hash" (dev mode), Unpin, Re-check, chain/RPC settings. `?tab=<id>` opens it as a page for a given tab.
- `apps/demo`: Vite dApp "Acme Treasury" (connect, send 0.01 ETH on Sepolia, sign message). `server.mjs` static server on 4173. `tamper.mjs` swaps the treasury address constant inside the served JS only (UI still shows the right address). `restore.mjs` undoes it, only when actually tampered.
- `scripts/e2e.mjs`: CLI end-to-end. `scripts/e2e-browser.mjs`: Playwright/Chromium with the extension loaded, an injected fake EIP-1193 wallet, and a fake wallet extension (`scripts/fixtures/fake-wallet`) for realistic injection order and frames. `scripts/demo.mjs`: `pnpm demo`, builds, writes manifest, serves, launches Chrome with the extension in `.chrome-profile/`.
- `.github/workflows/release.yml`: build, manifest, anchor on ENS using secret `WEBSEAL_CI_KEY` and vars `WEBSEAL_ENS_NAME`, `WEBSEAL_CHAIN`.
- `docs/TESTING.md`: full checklist. `docs/screenshots`: clean/tampered page and popup.

## Status

Passing, run with `pnpm test`, `pnpm e2e`, `pnpm e2e:browser` (2026-11-06):

- 10 core unit tests (incl. `verifyDocument` for SPA routes and the pure-JS SHA-256 fallback used on plain-http pages).
- CLI e2e, 8 checks: clean verifies, tamper fails naming the file, wrong anchor fails on the manifest, restore verifies, and ENS anchoring through a local fake ENS RPC (`scripts/fixtures/fake-ens-rpc.mjs`, the real viem lookup path): record only on `webseal.<name>`, two-hash rollout record, stale record, no record.
- Browser e2e, 60 checks. Added on 2026-11-06: the dApp's Send button reaches the wallet when clean and is refused by WebSeal when tampered, pinning by ENS name (fake ENS RPC), a tampered same-origin frame and a frame that plants code and removes itself, unlisted WebAssembly and service workers, wallet globals (`phantom`, `coinbaseWalletExtension`). Earlier: the original 17 (grey/green/red, signing blocked on red, reads and connect allowed, popup names the file, forged message, late injection) plus 12 bypass attempts by page code on a tampered page (built-in overrides, forged/replayed verdicts, getter TOCTOU, batched sendAsync, replaced request, leaked `this`, iframes incl. about:blank, opened windows), banner re-attach, re-check never un-fails, no re-verification on fetches, SPA route stays green, re-check in place, `*.eth.limo` without a record is grey, plain-http verifies, popup survives a service-worker stop, and the same attacks with a wallet installed as an extension. See `docs/work_artifacts/` for the review and fix log.

Manually confirmed by the user: real MetaMask connects through the WebSeal wrapper (so extension injection order is fine). The user's first send failed only because MetaMask was on mainnet; the demo now asks the wallet to switch to Sepolia on connect and before sending.

Demo video: `pnpm demo:record` records the whole demo with the test wallet, no human needed, to `docs/demo/webseal-demo.webm` (about 70 s); `--metamask <dir> --profile <dir>` (after a one-time `--setup`) records it with real MetaMask. See `docs/TESTING.md` §5. Two demo bugs it exposed are fixed: the tamper script's attacker address failed the EIP-55 checksum, so viem refused the send before WebSeal or the wallet saw it, and viem replaced WebSeal's error text with its generic code-4100 message (the dApp now shows the root cause).

Not yet exercised anywhere:

1. The MetaMask recording mode (`pnpm demo:record --metamask …`); the real-wallet send on a clean page (MetaMask confirmation should open) and on a tampered page (must be refused with "WebSeal blocked this request" before MetaMask opens). Re-run "connect" too: since the 2026-11-05 hardening the provider proxy refuses method replacement and `defineProperty` and wraps every method, which only the fake wallets have been tested against.
2. Live ENS record publish on Sepolia (needs a key and Sepolia ETH). Reads now work live: the CLI `record` command and the extension both resolved Sepolia and mainnet names on 2026-11-05. Code path is `packages/cli/src/ens.ts` and `packages/extension/src/ens.ts`.
3. The limited-rights CI key pattern: record on subname `webseal.<name>` owned by a throwaway key; the extension and now the CLI (`record`, `verify --name`) fall back to it. A positive fallback (record only on the subname) has not been seen live.

## Known limitations (also in README)

Poisoned source repo is out of scope. The extension re-fetches files to hash them (cache: force-cache), so a server serving different bytes to the re-fetch could evade it; the debugger API would close that. Service workers, WASM and web workers are not collected. ENS lookup trusts the RPC. Inline scripts must be listed in the manifest's `inline` array (the CLI extracts them from HTML at build time).

## Commands

```bash
pnpm install
pnpm build
pnpm test && pnpm e2e
pnpm e2e:browser                   # needs a Playwright Chromium: npx playwright install chromium
pnpm demo                          # builds, serves :4173, opens Chromium with the extension
pnpm demo:record                   # records the demo video to docs/demo/webseal-demo.webm
pnpm demo:tamper                   # attack
pnpm demo:restore                  # undo
node packages/cli/dist/webseal.js build --dist apps/demo/dist --name <name>.eth
WEBSEAL_PRIVATE_KEY=0x... node packages/cli/dist/webseal.js publish --name <name>.eth --chain sepolia
node packages/cli/dist/webseal.js record --name <name>.eth --chain sepolia
node packages/cli/dist/webseal.js verify http://localhost:4173 --name <name>.eth --chain sepolia
```

After any rebuild the manifest hash changes: re-pin in the popup.

## Suggested next steps

1. Finish the manual checks above, fix anything the real wallet reveals.
2. Register a Sepolia ENS name, publish, pin by name, screenshot green and red.
3. Subname-owned-by-CI-key demo for the ENS track; check whether ENSv2 testnet per-record permissions are available and use them if so.
4. Push to GitHub, set workflow secret/vars.
5. Stretch: emit Subresource Integrity attributes at build time; Arkiv mirror of manifests; hash real response bodies via the debugger API.
6. Three-minute demo video: green, run tamper, reload, red, blocked click, popup, ENS record on explorer, one sentence on Bybit at the end.
