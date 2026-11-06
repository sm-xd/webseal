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
| `packages/cli` | `webseal build`, `publish`, `record`, `verify`, `reproduce`, and the ENSv2 `grant`, `revoke`, `writers`, `link`. |
| `packages/extension` | Chrome extension (Manifest V3). Verifier, wallet gate, popup. |
| `apps/demo` | A small dApp that sends ETH to a treasury, a static server, and a tamper script. |
| `apps/wagmi-playground` | wagmi's open-source Vite + React playground (MIT, from `wevm/wagmi`), restyled, protected by WebSeal. `scripts/wagmi.mjs` builds, serves, tampers, restores and reproduces it. |
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

### ENSv2: who may change the record

WebSeal's guarantee is only as strong as the set of accounts that can change the `webseal` record, so it uses ENSv2's Permissioned Resolver to keep that set small and to show it:

```bash
# once, as the name's owner: a CI key that can change the webseal record and nothing else
webseal grant   --name smxreds.eth --to 0xCI_KEY --chain mainnet
# every release, as the CI key (publish detects the ENSv2 resolver and writes the v2 way)
WEBSEAL_PRIVATE_KEY=0x<CI key> webseal publish --name smxreds.eth --chain mainnet
# who can change it (the popup shows the same counts)
webseal writers --name smxreds.eth --chain mainnet --check 0xCI_KEY
# a leaked CI key: one call
webseal revoke  --name smxreds.eth --from 0xCI_KEY --chain mainnet
# record linking: beta.smxreds.eth serves the same release record
webseal link    --name beta.smxreds.eth --to smxreds.eth --chain mainnet
```

- **Per-record permission:** `grant` calls `grantSetterRoles` with a `setText(…, "webseal", …)` setter, so the CI key holds `ROLE_SET_TEXT` only on that key's resource. It cannot change the name's address, contenthash or any other record. A Permissioned Resolver's grants cover every name it serves, so if the owner points other names at the same resolver, the CI key can set their `webseal` record too.
- **Visible writers:** the popup and `webseal record`/`writers` read the resolver's role counts (`getAssigneeCount`): "1 account with full control, 1 key for this record only (ENSv2)". More than one full-control account is flagged, since each of them could anchor any build.
- **Wildcard subnames and linking:** `link` uses `linkToNode`. A subname like `beta.smxreds.eth` resolves through its parent's resolver by wildcard, so it can share the release record without being registered.
- **Dry runs:** add `--as 0xADDRESS` to any write to simulate it as that account. That checks the call would succeed and prints the gas and fee, with no key.

On a name with an ENSv1 resolver, `publish` writes the v1 way, and the extension also looks up `webseal.<name>`: let the CI key own only that subname for the same limited-rights effect.

During a release the record may list two hashes, `v1:sha256:<new>,<old>`: `webseal publish --keep-current` adds the new build next to the current one before the deploy, and a second `publish` without the flag (after the live site serves the new build) drops the old one. Visitors never see red in between. Without a custom RPC, the extension and the CLI read ENS through several public RPCs in turn.

### What it costs

Reading the record is free (an `eth_call`), so visitors pay nothing. Writes are paid in gas by whoever signs them: the owner for one-time setup, the CI key for each release. Measured on mainnet on 2026-11-06 at about 0.1 gwei and ETH at about $2,240:

| Write | Gas | Cost |
|---|---|---|
| `publish` (one hash) | ~140k | ~0.000014 ETH, about $0.03–0.04 |
| `publish --keep-current` (rollout, two hashes) | ~188k | ~0.00002 ETH, about $0.05 |
| `grant` a CI key (once) | ~89k | about $0.02 |
| `revoke` | ~38k | about $0.01 |
| `link` | ~66k | about $0.015 |

A release with a rollout is two transactions, about $0.09. Costs scale with the gas price: at 1 gwei multiply by ten. On Sepolia everything is free with faucet ETH.

### Prove the site is the public source: `webseal reproduce`

The ENS record proves a page is what the publisher's CI released. `reproduce` proves that release is what the public repository builds to, so nobody has to trust the publisher's CI either:

```bash
webseal reproduce https://app.example --build "pnpm install --frozen-lockfile && pnpm build" --dist dist --name app.eth
```

It reads the live manifest, which names its source (`webseal build --repo <git URL>` records the repo, and the commit by default), clones that repo at that commit into a temporary directory, runs the build, hashes the output exactly as `build` does, and compares every file and the manifest hash with what the site serves. It also re-checks the served files against the manifest and, with `--name`, that the build is anchored on ENS. The result is `REPRODUCED` or `DIFFERENT` with the files that differ. `--repo` and `--ref` override the manifest (for a manifest built with `--no-commit`).

For the wagmi app: `pnpm wagmi:build` (after committing and pushing), then `pnpm wagmi:reproduce http://localhost:4174`. Builds must be deterministic for this to work: the repo pins LF line endings (`.gitattributes`) and the lockfile, and the manifest leaves out timestamps.

Hosts of the form `app.eth.limo` or `app.eth.link` are derived automatically; any other host must be pinned once from the popup. A derived name that has no `webseal` record has not opted in and is treated as an unknown site (grey), not as a failure. The CLI's `record` and `verify --name` use the same name-then-subname lookup as the extension.

## How verification works

1. `main.js` runs in the page's own world, in every frame, before any page script. It installs an accessor on `window.ethereum` and on wallet-specific globals (`window.phantom.ethereum`, `window.coinbaseWalletExtension` and others) and re-announces EIP-6963 providers, wrapped so that signing methods (`eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v4`, and the rest) wait for a verdict and are refused on failure. Read-only calls and connecting are never blocked. The page's own code is assumed hostile: the wrapper only uses built-ins it captured before page code ran, reads each request's method once and passes a copy on, refuses to let the page replace provider methods, and never hands the raw provider out (callbacks get the wrapper as `this`; methods that return the provider return the wrapper).
2. `content.js` (isolated world) asks the service worker for the host's anchor, fetches `/.well-known/webseal.json`, hashes it, and compares it with the anchored value. Then it hashes the HTML document the page was loaded from, every same-origin script and stylesheet, WebAssembly the page fetches, and the scripts of the origin's service workers, and compares each with the manifest. A client-side route such as `/dashboard` passes when its HTML is byte-identical to a release page. Any file that differs, any file not in the manifest, any inline script not in the manifest's allow-list, and any cross-origin script is a failure.
3. Scripts and stylesheets added after load (dynamic imports, injected tags) are checked incrementally; ordinary `fetch`/XHR traffic such as RPC polling does not trigger anything. A page can go from green to red, never the other way without a reload: the popup's Re-check re-verifies in place but keeps a failed page failed, since its code already ran.
4. Frames and windows: a same-origin subframe (including `about:blank`, `srcdoc` and `blob:` frames) and a window opened by a same-origin page can be reached by the other page's code, so each takes the worse of its own verdict and the related page's, and a failure in either fails both. A same-origin frame registers with the top page synchronously, before any of its own scripts run, and the top page holds signing until that frame is verified; a frame that disappears before it is verified fails the page, since it could have planted code there.
5. The verdict reaches the page world over a private channel: `main.js` creates a detached `<webseal-channel>` element that `content.js` takes out of the document in the same injection step, before any page script runs. The status is the event type dispatched on that element, so page code can neither observe nor forge it. Per-tab results live in `chrome.storage.session`, so the popup survives the service worker being stopped.

Unknown sites (no pin, no derivable name, or a derived name without a record) are grey and nothing is blocked, so the extension does not break the rest of the web.

## What this does not protect against

- **A poisoned source repository.** If malicious code is merged, or a dependency in the lockfile is compromised, CI builds and anchors it faithfully. WebSeal proves you are running what was released, and `reproduce` proves the release is the public source, but not that the source is safe. Review is the complement; the public, reproducible source is what makes review meaningful.
- **A server that lies selectively.** The extension re-fetches each file (from the browser cache where possible) to hash it. A server that serves clean bytes to the re-fetch and poisoned bytes to the page would evade it. The Bybit and Ledger attacks were persistent file changes, not per-request games. A stronger version would hash real response bodies via the debugger API or Firefox's response filter.
- **Web workers' own imports, and WebAssembly fetched from a URL not ending in `.wasm`,** are not collected.
- **Wallet-specific globals.** The gate wraps `window.ethereum`, `ethereum.providers` and EIP-6963 providers. Known wallet globals are wrapped too, but a wallet with a global that is not on the list, or one whose methods return internal objects, can still be reached unwrapped by page code. Non-EVM providers (for example Solana's) are not gated. Closing this for good needs the wallet itself to ask WebSeal for the verdict.
- **The ENS lookup itself** goes over an RPC. A lying RPC could return a bad record. Pinning the hash, or reading through a light client, closes that.
- **Users without the extension.** The build step could also emit Subresource Integrity attributes so browsers enforce part of the check with no extension.

## CROPS

The lead property is **S**: the code you sign with is the code the publisher released, and that release is the public source. It is structural, not a setting: there is no WebSeal server, and nothing here needs us to keep running.

- **C, censorship resistance.** We run nothing users depend on: no server, API, relayer or account. The extension checks pages on the user's device against ENS, through three public RPCs in turn (publicnode, drpc, 1rpc) or any RPC the user sets in the popup. If the WebSeal project disappears, installed extensions, published records and `reproduce` keep working; anyone can build the extension from this repo and load it unpacked if a store removes it. Trade-off: if no RPC answers, a protected site fails closed (signing blocked, a clear reason shown) rather than open. We chose safety over availability on purpose, and only for sites that opted in; every other site is untouched.
- **O, open source.** MIT (`LICENSE`); the wagmi demo app keeps its upstream MIT license. Everything builds and runs from this repo alone with `pnpm install && pnpm build` (Quick start above). The anchor is an open ENS text record, and `webseal reproduce` lets anyone check that a live site matches this source.
- **P, privacy.** The extension contacts only the ENS RPC, and only for sites that are pinned or have an `*.eth.limo`/`*.eth.link` host, so the RPC provider learns the user's IP and which protected sites they open, not their general browsing. It never sees an address, a balance or a transaction. No analytics, trackers or telemetry anywhere in the extension, CLI or demo apps; nothing leaves the device except those `eth_call`s. Setting your own RPC (or a private one such as a light client or anon-rpc endpoint) removes the provider from the picture. The page's own fetches for hashing go only to the site the user is already on.
- **S, security.** The extension holds no keys and no user data; per-tab results live in session storage on the device. Trust assumptions: the ENS record (changed only by accounts the owner granted; with ENSv2 a CI key can change only the `webseal` record, and the popup shows how many accounts can change it), the RPC returning the true record (pin a hash or use your own node to remove that), and the browser and wallet themselves. The CLI reads a signing key from an environment variable and never writes it anywhere. Known gaps are listed in "What this does not protect against" above.

## Manifest format

```json
{
  "version": 1,
  "name": "acme-demo.eth",
  "commit": "<git sha>",
  "repo": "https://github.com/<org>/<repo>.git",
  "files": { "/index.html": "<sha256>", "/assets/index-abc.js": "<sha256>" },
  "inline": ["<sha256 of an allowed inline script body>"]
}
```

Served at `/.well-known/webseal.json`, encoded as canonical JSON (sorted keys, no whitespace). The ENS record is `v1:sha256:<sha256 of the manifest bytes>`.

## License

MIT
