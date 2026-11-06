# Screenshots: the whole flow on the wagmi app

Taken by `pnpm screenshots` (`scripts/screenshots.mjs`) against the live `smxreds.eth` record on Sepolia, in Chromium with WebSeal and the test wallet (`scripts/fixtures/fake-wallet`: no keys, sends nothing, records what it was asked to sign). CLI images are the real command output.

| # | File | What it shows |
|---|---|---|
| 1 | `01-cli-build-manifest.png` | The release manifest: every file's hash, the repo and commit it was built from |
| 2 | `02-cli-ens-record.png` | The `webseal` text record on smxreds.eth (Sepolia) |
| 3 | `03-cli-ens-writers.png` | ENSv2: who can change that record |
| 4 | `04-cli-verify-clean.png` | `webseal verify`: the live site matches the anchored release |
| 5 | `05-ext-installed.png` | WebSeal and the test wallet in chrome://extensions |
| 6 | `06-web-clean-verified.png` | The wagmi app, clean release, connected |
| 7 | `07-ext-popup-verified.png` | WebSeal popup: verified, anchor, writers, files |
| 8 | `08-web-send-form.png` | Send 0.0001 ETH to your own address |
| 9 | `09-web-send-reached-wallet.png` | The request reached the wallet (transaction hash) |
| 10 | `10-wallet-request-clean.png` | What the wallet was asked to sign: to = your address |
| 11 | `11-cli-tamper.png` | The attack: one served JS file changed |
| 12 | `12-web-tampered-banner.png` | Same URL after reload: red banner |
| 13 | `13-web-tampered-full.png` | The full tampered page: looks identical |
| 14 | `14-ext-popup-tampered.png` | WebSeal popup: blocked, the changed file named |
| 15 | `15-web-send-blocked-with-banner.png` | Send on the tampered page: refused, banner explains why |
| 16 | `16-web-send-blocked.png` | The Send cell's error (wagmi shows the generic 4100 text) |
| 17 | `17-wallet-request-tampered-blocked.png` | The wallet never received the transaction |
| 18 | `18-cli-verify-tampered.png` | `webseal verify`: FAILED, the mismatching file with both hashes |
| 19 | `19-cli-reproduce-tampered.png` | `reproduce`: the public source builds the release, but the site serves something else |
| 20 | `20-web-no-webseal-tampered-form.png` | Same attack, WebSeal not installed: you type your address |
| 21 | `21-web-no-webseal-sent.png` | The transaction goes out |
| 22 | `22-wallet-request-no-webseal.png` | What the wallet was asked to sign: to = 0xbad0…0bad, the attacker |
| 23 | `23-cli-restore.png` | Restore the release |
| 24 | `24-web-restored-verified.png` | Verified again |
| 25 | `25-ext-popup-restored.png` | Popup: verified |
| 26 | `26-cli-verify-restored.png` | `webseal verify`: VERIFIED |
| 27 | `27-cli-reproduce-clean.png` | `reproduce`: REPRODUCED from github.com/sm-xd/webseal at the release commit |

## MetaMask (taken by hand in Google Chrome)

The script cannot drive MetaMask. Save these next to the others, same flow, Sepolia, on http://localhost:4174:

| File | When |
|---|---|
| `mm-01-connect.png` | MetaMask's connect prompt after clicking **MetaMask** in Connect |
| `mm-02-confirm-clean.png` | Clean page, Send: MetaMask's confirmation showing **your** address (then Reject) |
| `mm-03-tampered-no-popup.png` | Tampered page, Send: the page with the red banner and no MetaMask window |
| `mm-04-confirm-attacker.png` | Tampered page with WebSeal turned off, Send: MetaMask showing **0xbad0…0bad** (then Reject) |

Windows: Win+Shift+S, select the area, then paste into Paint and save as PNG with the name above.

The four older files (`clean.png`, `tampered.png`, `popup-*.png`) are from the Acme demo app.
