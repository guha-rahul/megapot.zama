"use client";

import { createConfig, http } from "wagmi";
import { hardhat, sepolia } from "wagmi/chains";

import { chainId } from "./contracts";

/** The chain the configured deployment lives on. Both are registered so the connector can switch. */
export const activeChain = chainId === hardhat.id ? hardhat : sepolia;

// Wallets are discovered over EIP-6963 rather than via the `wagmi/connectors` barrel, which drags
// in the whole Coinbase account SDK (and its optional native deps) for a connector we never use.
export const wagmiConfig = createConfig({
  chains: [sepolia, hardhat],
  multiInjectedProviderDiscovery: true,
  transports: {
    [sepolia.id]: http(chainId === sepolia.id ? process.env.NEXT_PUBLIC_RPC_URL : undefined),
    [hardhat.id]: http(chainId === hardhat.id ? process.env.NEXT_PUBLIC_RPC_URL : undefined),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
