# WebSeal handoff

Context for a Claude Code session continuing this work on a local machine.

## What this is

WebSeal is a hackathon MVP (ETHGlobal, Ethereum Foundation CROPS track, with an ENS angle): a frontend integrity checker. It proves that the JavaScript a browser loaded for a dApp is the build its publisher released, and blocks wallet signing when it is not. Motivation: the February 2025 Bybit theft, where one JavaScript file on Safe{Wallet}'s hosting was changed while the repo stayed clean.

Trust chain: CI hashes every build file into a manifest, and the manifest's SHA-256 is written to an ENS text record (`webseal` = `v1:sha256:<hex>`). A Chrome extension resolves the record, fetches `/.well-known/webseal.json`, checks its hash, then hashes every loaded same-origin script, stylesheet and the HTML and compares. Mismatch, unlisted file, unlisted inline script or cross-origin script = red banner + wallet signing refused.

## Layout (pnpm workspace, Node 22, TypeScript, esbuild, viem)

- `packages/core/src/index.ts`: manifest format, canonical JSON, sha256, `normalizePath`, `verifyFiles`, `verifyInline`, `extractInlineScripts`, `SIGNING_METHODS`. Tests in `packages/core/test`.
- `packages/cli`: `webseal build|publish|record|verify`. Bundled to `packages/cli/dist/webseal.js`. ENS read/write in `src/ens.ts` (viem `getEnsText`, PublicResolver `setText`). Chains: `sepolia` (default), `mainnet`.
- `packages/extension` (Manifest V3, loads from `packages/extension/dist`):
  - `src/main.ts`: MAIN-world script at document_start. Wraps `window.ethereum` via accessor + Proxy and re-announces EIP-6963 providers wrapped. Signing methods wait for a verdict (20 s timeout) and reject with code 4100 on failure. Verdict messages are authenticated by a hash chain `sha256(token:seq)`; the token is passed from main.ts to content.ts through a DOM attribute read and deleted before page scripts run.
  - `src/content.ts`: isolated-world verifier. Gets the anchor from the service worker, verifies after `load`, re-verifies on injected scripts/links (MutationObserver + PerformanceObserver), posts status to main.ts, shows a sticky red banner in a closed shadow root.
  - `src/background.ts`: anchor lookup (pinned ENS name, pinned hash, or derived from `*.eth.limo`/`*.eth.link` hosts), ENS resolution with fallback to `webseal.<name>`, per-tab badge (✓ green, ✗ red, … pending, blank unknown).
  - `src/popup.*`: status, per-file list, "Pin ENS name", "Pin current manifest hash" (dev mode), Unpin, Re-check, chain/RPC settings. `?tab=<id>` opens it as a page for a given tab.
- `apps/demo`: Vite dApp "Acme Treasury" (connect, send 0.01 ETH on Sepolia, sign message). `server.mjs` static server on 4173. `tamper.mjs` swaps the treasury address constant inside the served JS only (UI still shows the right address). `restore.mjs` undoes it, only when actually tampered.
- `scripts/e2e.mjs`: CLI end-to-end. `scripts/e2e-browser.mjs`: Playwright/Chromium with the extension loaded and a fake EIP-1193 wallet. `scripts/demo.mjs`: `pnpm demo`, builds, writes manifest, serves, launches Chrome with the extension in `.chrome-profile/`.
- `.github/workflows/release.yml`: build, manifest, anchor on ENS using secret `WEBSEAL_CI_KEY` and vars `WEBSEAL_ENS_NAME`, `WEBSEAL_CHAIN`.
- `docs/TESTING.md`: full checklist. `docs/screenshots`: clean/tampered page and popup.

## Status

Passing, run with `pnpm test`, `pnpm e2e`, `node scripts/e2e-browser.mjs`:

- 8 core unit tests.
- CLI e2e: clean verifies, tamper fails naming the file, wrong anchor fails on the manifest, restore verifies.
- Browser e2e, 17 checks: grey/green/red states, signing blocked on red, reads and connect still allowed, popup names the changed file, forged status message from page JS does not unblock, script injected after load flips to red.

Manually confirmed by the user: real MetaMask connects through the WebSeal wrapper (so extension injection order is fine). The user's first send failed only because MetaMask was on mainnet; the demo now asks the wallet to switch to Sepolia on connect and before sending.

Not yet exercised anywhere:

1. The real-wallet send on a clean page (MetaMask confirmation should open) and on a tampered page (must be refused with "WebSeal blocked this request" before MetaMask opens).
2. Live ENS record publish/read on Sepolia (the cloud container's network blocked the RPC host). Code path is `packages/cli/src/ens.ts` and `packages/extension/src/ens.ts`.
3. The limited-rights CI key pattern: record on subname `webseal.<name>` owned by a throwaway key; the extension already falls back to it.

## Known limitations (also in README)

Poisoned source repo is out of scope. The extension re-fetches files to hash them (cache: force-cache), so a server serving different bytes to the re-fetch could evade it; the debugger API would close that. Service workers, WASM and web workers are not collected. ENS lookup trusts the RPC. Inline scripts must be listed in the manifest's `inline` array (the CLI extracts them from HTML at build time).

## Commands

```bash
pnpm install
pnpm build
pnpm test && pnpm e2e
node scripts/e2e-browser.mjs       # needs playwright + chromium
pnpm demo                          # builds, serves :4173, opens Chrome with the extension
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
