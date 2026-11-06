# MetaMask screenshots (you take these)

The storyboard needs three MetaMask shots. I cannot drive MetaMask, so these must come from you, in Google Chrome with WebSeal and MetaMask installed, on Sepolia, at http://localhost:4174 (`pnpm wagmi:serve`).

Save each as PNG **in this folder** with exactly these names.

| File | Storyboard | How to get it |
|---|---|---|
| `mm-02-confirm-clean.png` | 0:25–0:31 Clean | Clean build (`pnpm wagmi:restore`, reload, WebSeal badge ✓). Connect with MetaMask, Send 0.0001 ETH to your own address. When the MetaMask confirmation opens, capture **the MetaMask window** showing your address. Then **Reject**. |
| `mm-03-tampered-no-popup.png` | 0:35–0:43 Blocked | `pnpm wagmi:tamper`, reload (red banner). Click Send again. MetaMask does **not** open. Capture **the whole browser window**: red banner, the Send cell's error, and no MetaMask window. |
| `mm-04-confirm-attacker.png` | 0:43–0:48 Without WebSeal | Still tampered. In chrome://extensions turn WebSeal **off**, reload the page, Send to your own address again. MetaMask opens showing **0xbad0…0bad**. Capture **the MetaMask window**. Then **Reject** (never confirm). Turn WebSeal back on, then `pnpm wagmi:restore`. |
| `mm-01-connect.png` *(optional)* | not used | The MetaMask connect prompt. Only if you want a spare shot. |

Tips:
- Win+Shift+S → **Window mode** captures one window cleanly. Then open Paint, paste, save as PNG.
- Use a 1920×1080 (or larger) display at 100% Windows scaling if you can, so the shots stay sharp in a 1080p video.
- Make sure no private key, seed phrase or real balance is visible. A Sepolia test account is fine.
- If MetaMask shows the address shortened, click it or expand the details so `0xbad0…0bad` is clearly readable for mm-04.
