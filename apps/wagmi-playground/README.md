# wagmi playground (third-party, MIT)

Copied from [wevm/wagmi `playgrounds/vite-react`](https://github.com/wevm/wagmi/tree/main/playgrounds/vite-react)
(MIT, see `LICENSE`) to show WebSeal protecting a real open-source dApp frontend.

Changes from upstream: published package versions instead of the wagmi monorepo's
`workspace:`/`catalog:` ones, Vite 7 to match this repo, and the WalletConnect
connector removed (it needs a project ID). Browser wallets are found through EIP-6963.
The MetaMask SDK and Base Account connectors are removed as well (they need optional
packages); browser wallets, including the MetaMask extension, connect through EIP-6963.
`src/index.css` is a WebSeal-demo skin (blocky, minimal); the markup and logic are upstream.
