"use client";

import { useCallback, useState } from "react";
import { usePublicClient, useWalletClient } from "wagmi";

import { readableError } from "./format";

export type TxState = {
  text: string;
  kind?: "error" | "win";
  busy?: boolean;
  hash?: `0x${string}`;
} | null;

/**
 * One place for "send a transaction and narrate it".
 *
 * Every page needs the same three-beat story — submitting, confirming, done — and the same error
 * flattening. Duplicating it per page is how they drift apart.
 */
export function useTx() {
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const [state, setState] = useState<TxState>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (label: string, fn: () => Promise<`0x${string}`>, after?: () => void | Promise<void>) => {
      if (!walletClient || !publicClient) {
        setState({ text: "Connect a wallet first.", kind: "error" });
        return false;
      }
      setBusy(true);
      setState({ text: `${label}…`, busy: true });
      try {
        const hash = await fn();
        setState({ text: `${label} — waiting for confirmation`, busy: true, hash });
        await publicClient.waitForTransactionReceipt({ hash });
        setState({ text: `${label} — confirmed`, hash });
        await after?.();
        return true;
      } catch (e) {
        setState({ text: readableError(e), kind: "error" });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [walletClient, publicClient],
  );

  return { run, state, setState, busy, ready: Boolean(walletClient && publicClient) };
}
