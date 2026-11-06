# Testing WebSeal

## Already verified automatically

These run in CI and in any container with Node 22. No wallet, no chain, no human.

| Suite | Command | Covers |
|---|---|---|
| Core unit tests | `pnpm test` | canonical JSON, hashing (Web Crypto and the JS fallback), record parsing, path normalization, verify logic, inline scripts, document/SPA-route check |
| CLI end-to-end | `pnpm e2e` | 8 checks: build manifest, serve, verify passes, tamper, verify fails naming the file, wrong anchor fails, restore passes; ENS anchor through a local fake ENS RPC (record only on `webseal.<name>`, two-hash rollout record, stale record, no record) |
| Browser end-to-end | `pnpm e2e:browser` | extension in Chromium, 60 checks: the dApp's own Send button reaches the wallet on the clean page and is refused by WebSeal on the tampered one; pinning by ENS name through the fake ENS RPC; a tampered same-origin frame and a frame that plants code and removes itself; unlisted WebAssembly and service workers; wallet globals (`phantom`, `coinbaseWalletExtension`) with a wallet installed as an extension; plus grey/green/red states, signing blocked on red, reads still allowed, popup names the file, late injection flips to red, 12 bypass attempts by hostile page code, frames and opened windows, re-check semantics, no false alarms (SPA routes, `*.eth.limo` without a record, plain http), popup survives a service-worker restart |

The browser suite uses a fake EIP-1193 wallet injected by the test, plus a fake wallet *extension* (`scripts/fixtures/fake-wallet`) injected the way MetaMask-style wallets are, not MetaMask itself. The `*.eth.limo` check needs the Sepolia RPC and prints SKIP when it is unreachable. Playwright is not a repo dependency: install it globally (or anywhere and point `NODE_PATH` at it), matching a Chromium build you have.

## Needs a person

### 1. Real wallet on the clean and tampered page (10 min)

Why: the wallet gate wraps `window.ethereum` and EIP-6963 providers. Which extension's script runs first is not guaranteed. Both orders are handled in code, but only a real wallet proves it.

```bash
pnpm install
pnpm demo
```

`pnpm demo` builds, writes the manifest, serves http://localhost:4173, and opens Chromium with the extension loaded in a fresh profile under `.chrome-profile/`. It uses Playwright's Chromium (`npx playwright install chromium`) because Google Chrome 137+ ignores `--load-extension`; if it falls back to Google Chrome, load `packages/extension/dist` once via chrome://extensions → Developer mode → Load unpacked. The first time, install MetaMask into that profile from the Web Store, import or create a test wallet, and switch it to Sepolia. The profile persists.

Then:

1. Click the WebSeal icon, press **Pin current manifest hash**. Badge turns green.
2. Click **Connect wallet**, then **Send 0.01 ETH**. MetaMask must open its confirmation. Reject it. Expected log line on the page: `send failed: User rejected the request.`
3. In another terminal: `pnpm demo:tamper`. Reload.
4. Expected: red banner at the top naming `/assets/index-….js`, red badge, and **Send 0.01 ETH** logs `send failed: WebSeal blocked this request…` without MetaMask opening.
5. `pnpm demo:restore`, reload, green again.

Pass condition: step 2 opens MetaMask, step 4 does not.

If step 2 is blocked on the clean page, open DevTools on the page and run `window.ethereum.isMetaMask`. If it is `undefined`, the wallet set `window.ethereum` in a way the accessor did not catch. Report what `Object.getOwnPropertyDescriptor(window, 'ethereum')` prints.

### 2. ENS anchor on Sepolia (15 min, needs Sepolia ETH)

Why: the only path not exercised anywhere is the live ENS text record read and write.

1. Register a name at https://sepolia.app.ens.domains with a wallet holding Sepolia ETH.
2. Export that wallet's private key for the test (or use a throwaway wallet you made the name's manager).
3. Publish and read back:
   ```bash
   export WEBSEAL_PRIVATE_KEY=0x...
   node packages/cli/dist/webseal.js publish --name yourname.eth --chain sepolia
   node packages/cli/dist/webseal.js record  --name yourname.eth --chain sepolia
   node packages/cli/dist/webseal.js verify http://localhost:4173 --name yourname.eth --chain sepolia
   ```
   Expected: `publish` prints a tx hash with status `success`, `record` prints `v1:sha256:<hash>`, `verify` prints `VERIFIED`.
4. In the popup, type `yourname.eth`, press **Pin ENS name**. Badge turns green with the anchor shown as `yourname.eth (sepolia)`.
5. Tamper, reload, red. Restore, reload, green.

### 3. Limited-rights CI key with ENSv2 (ENS track story, 15 min)

Works on any name with an ENSv2 Permissioned Resolver (mainnet names registered or migrated after the ENSv2 launch, and Sepolia names from https://sepolia.app.ens.domains). `smxreds.eth` on mainnet already has one. Add `--as 0xADDRESS` to any write first to dry-run it and see the cost.

1. Make a second throwaway wallet, the "CI key", and give it a little ETH for gas (Sepolia: faucet; mainnet: about $1 covers dozens of releases).
2. As the owner, let it change only the `webseal` record:
   ```bash
   WEBSEAL_PRIVATE_KEY=0x<owner key> node packages/cli/dist/webseal.js grant --name yourname.eth --to 0x<CI address> --chain sepolia
   ```
3. Publish with the CI key, then check:
   ```bash
   WEBSEAL_PRIVATE_KEY=0x<ci key> node packages/cli/dist/webseal.js publish --name yourname.eth --chain sepolia
   node packages/cli/dist/webseal.js writers --name yourname.eth --chain sepolia --check 0x<CI address>
   ```
   Expected: the publish succeeds, `writers` shows "1 with only this record" and the CI address CAN change it. The popup's "Can change it" row says "1 account with full control, 1 key for this record only (ENSv2)".
4. Show it can do nothing else: in the ENS app, connected as the CI wallet, try to edit any other record of `yourname.eth`; it is refused. That is the demo line: "a leaked CI key can publish a bad hash and nothing else, and one `revoke` takes even that away".
5. Revoke: `WEBSEAL_PRIVATE_KEY=0x<owner key> node packages/cli/dist/webseal.js revoke --name yourname.eth --from 0x<CI address> --chain sepolia`, then `writers` shows 0 with only this record.

If `writers` reports more than one account with full control, find out who the others are before the demo (the resolver's `EACRolesChanged` events on resource 0 in a block explorer, or `--rpc` with your own node URL): each of them can anchor any build. On a name with an ENSv1 resolver, use the subname pattern instead: transfer `webseal.yourname.eth` to the CI key and publish to the subname; the extension falls back to it.

### 4. Push to GitHub (2 min)

Create an empty repository, then from the unzipped source:

```bash
git remote add origin git@github.com:<you>/webseal.git
git push -u origin main
```

Set repository variables `WEBSEAL_ENS_NAME` and `WEBSEAL_CHAIN`, and the secret `WEBSEAL_CI_KEY`, and the release workflow anchors every push to `main`.

### 5. Record the demo

**Automatic (no human, test wallet), about 70 seconds:**

```bash
pnpm build
pnpm demo:record          # -> docs/demo/webseal-demo.webm
```

The recorder drives Chromium with WebSeal and the test wallet extension (`scripts/fixtures/fake-wallet`), captures every page, and assembles a captioned 1280x720 video: title, the `webseal build` output, the clean page verified with the popup, Send reaching the wallet, the real `pnpm demo:tamper` output, the reload with the red banner and the popup naming the changed file, Send refused with "WebSeal blocked this request", restore, and the Bybit card. Captions come from what actually happened (the dApp's log, the requests the wallet received); if the tampered send fails for any other reason the recorder prints a WARNING and the caption says so. The test wallet has no confirmation window, which the caption states.

**With real MetaMask** (not yet run end to end; the recorder never clicks inside MetaMask):

```bash
# once: a visible Chromium with WebSeal + MetaMask in its own profile
pnpm demo:record --setup --metamask <unpacked MetaMask folder> --profile .demo-profile
#   create or import a throwaway wallet (no funds needed), switch to Sepolia,
#   press "Connect wallet" in the demo tab and approve, close the window
# then, every time:
MM_PASSWORD=<that password> pnpm demo:record --metamask <unpacked MetaMask folder> --profile .demo-profile
```

Get the unpacked folder from MetaMask's GitHub releases (`metamask-chrome-<version>.zip`, check its SHA-256 against the release page, unzip). The recorder unlocks MetaMask, records its confirmation window when it opens on the clean page and closes it (a rejection), and on the tampered page records that no MetaMask window opens. Add `--ens-name yourname.eth` once §2 is done to pin the real ENS name instead of the manifest hash.

**By hand**, the suggested order, about three minutes:

1. Page open, badge green, popup showing files verified against the ENS name.
2. Terminal beside it: `pnpm demo:tamper`. Reload.
3. Red banner, click Send, nothing happens except the log line.
4. Popup: the changed file, expected vs served hash.
5. Block explorer: the ENS record and the CI wallet that can only edit it.
6. One sentence on Bybit at the end, not the start.
