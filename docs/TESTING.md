# Testing WebSeal

## Already verified automatically

These run in CI and in any container with Node 22. No wallet, no chain, no human.

| Suite | Command | Covers |
|---|---|---|
| Core unit tests | `pnpm test` | canonical JSON, hashing, record parsing, path normalization, verify logic, inline scripts |
| CLI end-to-end | `pnpm e2e` | build manifest, serve, verify passes, tamper, verify fails naming the file, wrong anchor fails, restore passes |
| Browser end-to-end | `node scripts/e2e-browser.mjs` | extension in Chromium: grey/green/red states, signing blocked on red, reads still allowed, popup names the file, forged status message from page JS does not unblock, script injected after load flips to red |

The browser suite uses a fake EIP-1193 wallet injected by the test, not MetaMask.

## Needs a person

### 1. Real wallet on the clean and tampered page (10 min)

Why: the wallet gate wraps `window.ethereum` and EIP-6963 providers. Which extension's script runs first is not guaranteed. Both orders are handled in code, but only a real wallet proves it.

```bash
pnpm install
pnpm demo
```

`pnpm demo` builds, writes the manifest, serves http://localhost:4173, and opens Chrome with the extension loaded in a fresh profile under `.chrome-profile/`. The first time, install MetaMask into that profile from the Web Store, import or create a test wallet, and switch it to Sepolia. The profile persists.

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

### 3. Limited-rights CI key (ENS track story, 15 min)

1. Create the subname `webseal.yourname.eth` and transfer it to a second throwaway wallet (the "CI key").
2. Publish with the CI key to the subname:
   ```bash
   WEBSEAL_PRIVATE_KEY=0x<ci key> node packages/cli/dist/webseal.js publish --name webseal.yourname.eth --chain sepolia
   ```
3. Clear the record on the parent name (or never set it). Pin `yourname.eth` in the popup. The extension falls back to `webseal.yourname.eth` and goes green.
4. Try to set any record on `yourname.eth` with the CI key: it must fail. That is the demo line: "a leaked CI key can publish a bad hash and nothing else."

If the ENS track supports ENSv2 per-record permissions on its testnet, replace the subname with a permission for the CI key on the `webseal` key of the parent name.

### 4. Push to GitHub (2 min)

Create an empty repository, then from the unzipped source:

```bash
git remote add origin git@github.com:<you>/webseal.git
git push -u origin main
```

Set repository variables `WEBSEAL_ENS_NAME` and `WEBSEAL_CHAIN`, and the secret `WEBSEAL_CI_KEY`, and the release workflow anchors every push to `main`.

### 5. Record the demo (30 min)

Suggested order, about three minutes:

1. Page open, badge green, popup showing files verified against the ENS name.
2. Terminal beside it: `pnpm demo:tamper`. Reload.
3. Red banner, click Send, nothing happens except the log line.
4. Popup: the changed file, expected vs served hash.
5. Block explorer: the ENS record and the CI wallet that can only edit it.
6. One sentence on Bybit at the end, not the start.
