import { del, get, set } from 'idb-keyval'
import { createConfig, createStorage, http } from 'wagmi'
import {
  celo,
  mainnet,
  optimism,
  sepolia,
  tempo,
  tempoTestnet,
} from 'wagmi/chains'
import { tempoWallet } from 'wagmi/tempo'

const indexedDBStorage = {
  async getItem(name: string) {
    return get(name)
  },
  async setItem(name: string, value: string) {
    await set(name, value)
  },
  async removeItem(name: string) {
    await del(name)
  },
}

export const config = createConfig({
  chains: [mainnet, sepolia, optimism, celo, tempo, tempoTestnet],
  connectors: [
    tempoWallet(),
    // Browser wallets (MetaMask, Phantom, ...) are found through EIP-6963. The MetaMask SDK
    // and Base Account connectors need optional packages this copy does not install.
  ],
  storage: createStorage({ storage: indexedDBStorage, key: 'vite-react' }),
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
    [optimism.id]: http(),
    [celo.id]: http(),
    [tempo.id]: http(),
    [tempoTestnet.id]: http(),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}
