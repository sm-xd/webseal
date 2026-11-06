# Fonts

The project ships **no font files and loads no web fonts** (the demo server's Content-Security-Policy allows none). Every UI uses system font stacks, so what renders depends on the OS. The screenshots were taken on Windows 11, where the stacks resolve to **Segoe UI** (sans) and **Cascadia Mono** (mono).

| Where | Sans stack | Mono stack |
|---|---|---|
| wagmi skin (`apps/wagmi-playground/src/index.css`) | `ui-sans-serif, system-ui, 'Segoe UI', Helvetica, Arial, sans-serif` | `ui-monospace, 'Cascadia Mono', 'SF Mono', Consolas, monospace` |
| Extension popup (`packages/extension/src/popup.css`) | `system-ui, sans-serif` (13px/1.4) | `ui-monospace, monospace` (11–12px) |
| Red banner (`packages/extension/src/content.ts`) | `system-ui, sans-serif` (14px, title 15px) | `ui-monospace, monospace` |
| Terminal images (`scripts/screenshots.mjs`) | `ui-sans-serif, system-ui, 'Segoe UI', sans-serif` (title bar) | `ui-monospace, 'Cascadia Mono', Consolas, monospace` |

Type styles used by the wagmi skin, for matching in the video:

- Title bar: sans 700, 22px, letter-spacing -0.01em
- Cell labels: mono 600, 11px, letter-spacing 0.12em, UPPERCASE, muted color
- Values: mono 13px, tabular numbers
- Buttons: sans 600, 13px

For the video: render with the same stacks on Windows (Segoe UI + Cascadia Mono) so text matches the screenshots. If you edit on a Mac, the stacks fall back to SF Pro / SF Mono and will look slightly different.
