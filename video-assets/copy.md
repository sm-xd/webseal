# Existing copy

Text that already exists in the project, quoted exactly, with its source. Anything not listed here is new copy written for the video (see the end).

## Taglines and descriptions

| Text | Source |
|---|---|
| "Verify that the frontend you loaded is the one its publisher released. Block wallet signing when it is not." | `README.md`, line 3 (the project's headline) |
| "WebSeal makes that comparison on every page load." | `README.md` |
| "Checks that the frontend you loaded matches the build hash its publisher anchored on ENS. Blocks wallet signing when it does not." | `packages/extension/manifest.json` (extension description) |
| "The ENS name is the root of trust. Writing its record needs a wallet signature and is public and timestamped." | `README.md` |
| "The lead property is S: the code you sign with is the code the publisher released, and that release is the public source. It is structural, not a setting: there is no WebSeal server, and nothing here needs us to keep running." | `README.md`, CROPS section |

## The problem (the only incident the repo cites)

"In February 2025, attackers changed one JavaScript file on the server that hosts the Safe{Wallet} web app. The repo was clean, the contracts were fine, the hardware wallets worked. Bybit's signers approved what looked like a routine transfer and lost about $1.5B. Nothing compared the bytes running in the browser with the bytes the project meant to ship." — `README.md`

## UI strings (as users see them)

| Text | Where |
|---|---|
| "WebSeal: this page's code does not match the build its publisher released. Wallet signing and transactions are blocked on this page." | red banner (`content.ts`) |
| "Verified. 4 file(s) match the release anchored on smxreds.eth (sepolia)." | popup, clean (screenshot 07) |
| "Blocked. 1 file(s) differ from the release. Wallet signing is disabled on this page." | popup, tampered (screenshot 15) |
| "Can change it: 2 accounts with full control, 1 key for this record only (ENSv2)" | popup (screenshot 08) |
| "REPRODUCED: the site serves exactly what this commit builds to" | `webseal reproduce` (screenshot 28) |
| "DIFFERENT: the site does not serve what this commit builds to" | `webseal reproduce` (screenshot 20) |
| "result VERIFIED" / "result FAILED" | `webseal verify` (screenshots 04, 19, 27) |

## Claims the storyboard uses, and where they come from

| Claim | Source |
|---|---|
| ~$1.5B, Bybit, one JavaScript file on Safe{Wallet}'s host | `README.md` |
| CI hashes every file; the manifest hash is in the ENS text record `webseal` | `README.md`, `packages/cli/src/index.ts` |
| With ENSv2 the CI key can change only that record | `README.md` (ENSv2 section), live `webseal writers` output (screenshot 03) |
| No WebSeal server · no trackers · MIT · fails closed | `README.md` CROPS section; `LICENSE`; tracker scan of the extension, CLI and demo apps (no analytics found); `content.ts` blocks signing when the background lookup is unreachable |
| Anyone can rebuild it from the public repo to the same bytes | `webseal reproduce` run against github.com/sm-xd/webseal (screenshot 28) |

## New copy (written for the storyboard, not in the repo)

- "Is this the code they shipped?" (intro)
- "Check the frontend before you sign." (close)
- The voice-over lines in the storyboard.

These are new. Change them freely; nothing in the project depends on them.
