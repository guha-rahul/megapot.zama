"use client";

import { getPublicClient as wagmiPublicClient, getWalletClient as wagmiWalletClient } from "wagmi/actions";

import { wagmiConfig } from "./wagmi";

/**
 * Imperative viem clients for use inside async handlers.
 *
 * The hook forms (`usePublicClient`/`useWalletClient`) return possibly-undefined values that every
 * call site then has to narrow; inside a multi-step async flow that check goes stale. These throw
 * once, at the point of use, with a message worth reading.
 */
export function getPublicClient() {
  const client = wagmiPublicClient(wagmiConfig);
  if (!client) throw new Error("No RPC client — check the network configuration.");
  return client;
}

export async function getWalletClient() {
  const client = await wagmiWalletClient(wagmiConfig);
  if (!client) throw new Error("No wallet connected.");
  return client;
}
