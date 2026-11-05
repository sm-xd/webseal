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
node scripts/e2e-browser.mjs   # same in Chromium with the extension (needs playwright)
```

### One command

```bash
pnpm demo
```

Builds, writes the manifest, serves the site and opens Chrome with the extension loaded in a separate profile. See `docs/TESTING.md` for the full checklist, including the real-wallet and ENS steps.

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

Hosts of the form `app.eth.limo` or `app.eth.link` are derived automatically; any other host must be pinned once from the popup.

## How verification works

1. `main.js` runs in the page's own world before any page script. It installs an accessor on `window.ethereum` and re-announces EIP-6963 providers, wrapped so that signing methods (`eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v4`, and the rest) wait for a verdict and are refused on failure. Read-only calls and connecting are never blocked.
2. `content.js` (isolated world) asks the service worker for the host's anchor, fetches `/.well-known/webseal.json`, hashes it, and compares it with the anchored value. Then it hashes the HTML document and every same-origin script and stylesheet the page loaded, and compares each with the manifest. Any file that differs, any file not in the manifest, any inline script not in the manifest's allow-list, and any cross-origin script is a failure.
3. Scripts added after load (dynamic imports, injected tags) trigger a re-check. A page can go from green to red; never the other way without a reload.
4. The verdict reaches the page world as a hash-chained message: each message is proved with `sha256(token:seq)`, where the token was handed between the two extension scripts through a DOM attribute that is read and deleted before the first page script can run. Page code that watches one message cannot forge or replay the next. The test suite includes this case.

Unknown sites (no pin, no derivable name) are grey and nothing is blocked, so the extension does not break the rest of the web.

## What this does not protect against

- **A poisoned source repository.** If malicious code is merged, CI builds and anchors it faithfully. WebSeal proves you are running what was released, not that the release is safe. Reproducible builds and review are the complement.
- **A server that lies selectively.** The extension re-fetches each file (from the browser cache where possible) to hash it. A server that serves clean bytes to the re-fetch and poisoned bytes to the page would evade it. The Bybit and Ledger attacks were persistent file changes, not per-request games. A stronger version would hash real response bodies via the debugger API or Firefox's response filter.
- **Service workers, WebAssembly and web workers** are not collected yet.
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
