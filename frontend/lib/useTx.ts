"use client";

import { useCallback, useState } from "react";
import { usePublicClient, useWalletClient } from "wagmi";

import { readableError } from "./format";
import { poolChain } from "./wagmi";

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

      // Every write in this app targets the pool's chain. Sending one from a wallet on another
      // network does not fail cleanly — it hangs inside the wallet's gas estimation, which the
      // page cannot distinguish from a user who has not pressed confirm yet. Refusing up front
      // costs one comparison and turns a dead spinner into an instruction.
      const on = walletClient.chain?.id;
      if (on !== undefined && on !== poolChain.id) {
        setState({
          text: `Your wallet is on the wrong network — switch to ${poolChain.name} and try again.`,
          kind: "error",
        });
        return false;
      }

      setBusy(true);
      setState({ text: `${label}…`, busy: true });

      // A wallet that never answers leaves this spinner up forever with nothing to act on. It
      // happens for real — a stuck extension request queue is the common cause — so after a
      // wait far longer than any confirm dialog takes, say what to go and look at.
      const nudge = setTimeout(() => {
        setState({
          text: `${label} — your wallet has not responded. Check the extension for a pending request; if there is none, reload the page.`,
          busy: true,
        });
      }, 20_000);

      try {
        const hash = await fn();
        clearTimeout(nudge);
        setState({ text: `${label} — waiting for confirmation`, busy: true, hash });
        await publicClient.waitForTransactionReceipt({ hash });
        setState({ text: `${label} — confirmed`, hash });
        await after?.();
        return true;
      } catch (e) {
        setState({ text: readableError(e), kind: "error" });
        return false;
      } finally {
        clearTimeout(nudge);
        setBusy(false);
      }
    },
    [walletClient, publicClient],
  );

  return { run, state, setState, busy, ready: Boolean(walletClient && publicClient) };
}
