"use client";

import { useCallback, useState } from "react";
import { useAccount, useSwitchChain, useWalletClient } from "wagmi";

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
  const { chainId: current } = useAccount();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const go = useCallback(async () => {
    setError(null);

    // Asking a wallet to switch to the chain it is already on is a no-op at best and, in some
    // MetaMask builds, an internal error. Nothing to do here either way.
    if (current === poolChain.id) return;

    try {
      await switchChainAsync({ chainId: poolChain.id });
      return;
    } catch (e) {
      const code = (e as { code?: number })?.code;
      const unknownChain = code === 4902 || /unrecognized|unknown chain|not added/i.test(String(e));

      // Some wallet builds throw from inside their own UI rather than returning an EIP-1193
      // error — the observed case is MetaMask failing to resolve the requesting origin after the
      // dapp moved to a different port, which surfaces as a TypeError about `origin` with no app
      // frames in the stack. Nothing the page does can fix that, so say what will.
      if (/reading 'origin'|Cannot read propert|undefined is not an object/i.test(String(e))) {
        setError(
          `Your wallet could not handle the switch request. Change the network to ${poolChain.name} ` +
            "in the wallet itself, then reload. If it persists, remove this site from the wallet's " +
            "connected sites and connect again.",
        );
        return;
      }

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
  }, [switchChainAsync, walletClient, current]);

  return { go, busy: isPending || adding, error, target: poolChain };
}
