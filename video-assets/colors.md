# Colors

Exact values from the project's CSS. There is no design-token file, Tailwind config or brand guide; these are all the colors the shipped UI uses.

## Video style (approved: blocky grey/ink) — `apps/wagmi-playground/src/index.css`

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#e8eaed` | `#0b0c0e` | page background |
| `--cell` | `#ffffff` | `#15171b` | cell / card background |
| `--ink` | `#101114` | `#eceef2` | text, 2px rules, title bar |
| `--muted` | `#5b606b` | `#9aa0ab` | labels, secondary text |
| `--line` | `#101114` | `#eceef2` | borders (2px) |
| `--accent` | `#2348ff` | `#5b7bff` | primary buttons, focus, the Send cell's left bar |
| `--accent-ink` | `#ffffff` | `#0b0c0e` | text on accent |
| `--hatch` | `#c9ccd3` | `#2a2d33` | disabled-button hatching |

Note: this skin was written during the hackathon for the demo app (the markup is wagmi's).

## WebSeal extension — `packages/extension/src/popup.css`, banner in `packages/extension/src/content.ts`

| Value | Use |
|---|---|
| `#2b6cff` | buttons; also the icon fill (`rgb(43,108,255)` in `scripts/icons.mjs`) |
| `#1a8f3c` | verified: status dot, "ok" file status |
| `rgba(26,143,60,.12)` | verified summary background |
| `#b00020` | blocked: status dot, "mismatch", **red banner background** |
| `rgba(176,0,32,.12)` | blocked summary background |
| `#e0a400` | pending status dot |
| `#999999` | unknown status dot, secondary button border |
| `#ffffff` / `#111111` | popup background / text (light) |
| `#151821` / `#eeeeee` / `#0f1115` / `#444444` | popup dark mode: background / text / inputs / input border |
| `#bbbbbb` | input border (light) |
| `#ffffff` on `#b00020` | banner text |

## Terminal images — `scripts/screenshots.mjs` (renders real CLI output)

| Value | Use |
|---|---|
| `#0b0c0e` | terminal background |
| `#101114` | terminal title bar |
| `#eceef2` | terminal text |
| `#5b7bff` | prompt |
| `#4ade80` | VERIFIED / REPRODUCED / ok |
| `#ff6b6b` | FAILED / MISMATCH / DIFFERENT / attacker address |

## Acme demo app (not in the storyboard) — `apps/demo/src/style.css`

`#f6f7f9` background, `#ffffff` cards, `#111111` text, `#2b6cff` buttons; dark `#0f1115` / `#181b22` / `#eeeeee`.

## Suggested video palette (from the above, nothing new)

All screenshots are in **dark mode**, so the video should use the wagmi skin's dark values:

paper `#0b0c0e` · cell `#15171b` · ink `#eceef2` · muted `#9aa0ab` · accent `#5b7bff` · verified `#1a8f3c` · blocked `#b00020`.

(Light equivalents: paper `#e8eaed` · cell `#ffffff` · ink `#101114` · muted `#5b606b` · accent `#2348ff`.)
