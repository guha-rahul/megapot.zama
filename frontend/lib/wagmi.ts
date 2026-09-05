"use client";

import { createConfig, fallback, http } from "wagmi";
import { baseSepolia, sepolia } from "wagmi/chains";

import { customBaseRpc, customRpc } from "./rpc";

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
 * A keyed endpoint is tried first when there is one. It can come from `NEXT_PUBLIC_RPC_URL` at
 * build time, or from the viewer's own browser at runtime (`lib/rpc.ts`) — the latter matters
 * because the person being rate-limited is usually not the person who can redeploy.
 */

/** Public endpoints, in preference order. A keyed URL from the environment goes in front. */
const sepoliaRpcs = [
  customRpc(),
  process.env.NEXT_PUBLIC_RPC_URL,
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://rpc.sepolia.org",
  "https://sepolia.drpc.org",
].filter(Boolean) as string[];

const baseSepoliaRpcs = [
  customBaseRpc(),
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
