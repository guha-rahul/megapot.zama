"use client";

import { useCallback, useState } from "react";
import { useSwitchChain, useWalletClient } from "wagmi";

import { readableError } from "./format";
import { poolChain } from "./wagmi";

/**
 * Move the wallet to the chain the pool lives on.
 *
 * `switchChain` alone is not enough: if the wallet has never heard of Sepolia it rejects the
 * request (EIP-1193 code 4902) and some wallets then fall back to showing their own network
 * picker, which looks like the app asked for the wrong chain. So we catch that, ask the wallet to
 * *add* the chain with full parameters, and retry.
 */
export function useChainSwitch() {
  const { switchChainAsync, isPending } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const go = useCallback(async () => {
    setError(null);
    try {
      await switchChainAsync({ chainId: poolChain.id });
      return;
    } catch (e) {
      const code = (e as { code?: number })?.code;
      const unknownChain = code === 4902 || /unrecognized|unknown chain|not added/i.test(String(e));
      if (!unknownChain || !walletClient) {
        setError(readableError(e));
        return;
      }
    }

    // The wallet doesn't know Sepolia — add it, then switch.
    setAdding(true);
    try {
      await walletClient.addChain({ chain: poolChain });
      await switchChainAsync({ chainId: poolChain.id });
    } catch (e) {
      setError(readableError(e));
    } finally {
      setAdding(false);
    }
  }, [switchChainAsync, walletClient]);

  return { go, busy: isPending || adding, error, target: poolChain };
}
