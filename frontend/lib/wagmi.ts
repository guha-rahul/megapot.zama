"use client";

import { createConfig, http } from "wagmi";
import { baseSepolia, sepolia } from "wagmi/chains";

/**
 * Both chains are registered: the confidential pool lives on Ethereum Sepolia (the Zama Protocol
 * is not deployed on Base), the Megapot leg on Base Sepolia. Reads for the Base side pass
 * `chainId` explicitly, so the app shows both halves without asking the user to switch.
 *
 * Wallets are discovered over EIP-6963 rather than through the `wagmi/connectors` barrel, which
 * drags in the whole Coinbase account SDK for a connector this app never uses.
 */
export const poolChain = sepolia;
export const megapotChain = baseSepolia;

export const wagmiConfig = createConfig({
  chains: [sepolia, baseSepolia],
  multiInjectedProviderDiscovery: true,
  transports: {
    [sepolia.id]: http(process.env.NEXT_PUBLIC_RPC_URL || undefined),
    [baseSepolia.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL || undefined),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
