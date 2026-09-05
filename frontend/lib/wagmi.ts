"use client";

import { createConfig, fallback, http } from "wagmi";
import { baseSepolia, sepolia } from "wagmi/chains";

/**
 * Both chains are registered: the confidential pool lives on Ethereum Sepolia (the Zama Protocol
 * is not deployed on Base), the Megapot leg on Base Sepolia. Reads for the Base side pass
 * `chainId` explicitly, so the app shows both halves without asking the user to switch.
 *
 * Wallets are discovered over EIP-6963 rather than through the `wagmi/connectors` barrel, which
 * drags in the whole Coinbase account SDK for a connector this app never uses.
 *
 * Transports are a `fallback` over several public endpoints rather than a single one. Every page
 * here polls on an interval, and a handful of people with the app open at once is enough to get
 * rate-limited by any one free provider — at which point the app looks broken rather than busy.
 * viem's fallback ranks by latency and moves on when a node starts failing, so one throttled
 * provider costs a retry instead of the session.
 *
 * Set `NEXT_PUBLIC_RPC_URL` to a keyed endpoint (Alchemy, Infura) and it is tried first. That is
 * still the right answer under real load; this is what makes the app survive without one.
 */

/** Public endpoints, in preference order. A keyed URL from the environment goes in front. */
const sepoliaRpcs = [
  process.env.NEXT_PUBLIC_RPC_URL,
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://rpc.sepolia.org",
  "https://sepolia.drpc.org",
].filter(Boolean) as string[];

const baseSepoliaRpcs = [
  process.env.NEXT_PUBLIC_BASE_RPC_URL,
  "https://base-sepolia-rpc.publicnode.com",
  "https://sepolia.base.org",
  "https://base-sepolia.drpc.org",
].filter(Boolean) as string[];
export const poolChain = sepolia;
export const megapotChain = baseSepolia;

export const wagmiConfig = createConfig({
  chains: [sepolia, baseSepolia],
  multiInjectedProviderDiscovery: true,
  transports: {
    [sepolia.id]: fallback(sepoliaRpcs.map((url) => http(url))),
    [baseSepolia.id]: fallback(baseSepoliaRpcs.map((url) => http(url))),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
