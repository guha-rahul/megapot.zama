"use client";

import { useCallback, useMemo, useState } from "react";
import type { Address } from "viem";
import { useAccount, useReadContract, useReadContracts, useWalletClient } from "wagmi";

import { addresses, confidentialUsdcAbi, megaPotAbi } from "./contracts";
import { createDecryptSession, encryptAmount, userDecrypt, type DecryptSession } from "./zama";

/** Everything the pool publishes in the clear. */
export function usePublicState() {
  const base = { address: addresses.megaPot, abi: megaPotAbi } as const;
  const { data, refetch } = useReadContracts({
    contracts: [
      { ...base, functionName: "prizeReserve" },
      { ...base, functionName: "settledTickets" },
      { ...base, functionName: "deployedPrincipal" },
      { ...base, functionName: "roundsLength" },
      { ...base, functionName: "entryRound" },
      { ...base, functionName: "depositsPaused" },
    ],
    query: { refetchInterval: 12_000, enabled: Boolean(addresses.megaPot) },
  });

  const roundsLength = (data?.[3]?.result as bigint | undefined) ?? 0n;
  const latestRoundId = roundsLength > 0n ? roundsLength - 1n : undefined;

  const { data: round, refetch: refetchRound } = useReadContract({
    ...base,
    functionName: "getRound",
    args: latestRoundId !== undefined ? [latestRoundId] : undefined,
    query: { enabled: latestRoundId !== undefined, refetchInterval: 12_000 },
  });

  return {
    prizeReserve: data?.[0]?.result as bigint | undefined,
    settledTickets: data?.[1]?.result as bigint | undefined,
    deployedPrincipal: data?.[2]?.result as bigint | undefined,
    roundsLength,
    entryRound: data?.[4]?.result as bigint | undefined,
    depositsPaused: data?.[5]?.result as boolean | undefined,
    latestRoundId,
    round,
    refetch: () => {
      void refetch();
      void refetchRound();
    },
  };
}

/**
 * The private half of the UI: handles the pool published for this user, and the one signature
 * that unlocks reading them.
 */
export function usePrivateState() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [session, setSession] = useState<DecryptSession | null>(null);
  const [balance, setBalance] = useState<bigint | undefined>();
  const [tickets, setTickets] = useState<bigint | undefined>();
  const [walletBalance, setWalletBalance] = useState<bigint | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: balanceHandle, refetch: refetchBalance } = useReadContract({
    address: addresses.megaPot,
    abi: megaPotAbi,
    functionName: "confidentialBalanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && addresses.megaPot) },
  });

  const { data: ranges, refetch: refetchRanges } = useReadContract({
    address: addresses.megaPot,
    abi: megaPotAbi,
    functionName: "rangesOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && addresses.megaPot) },
  });

  const { data: walletHandle, refetch: refetchWallet } = useReadContract({
    address: addresses.confidentialUSDC,
    abi: confidentialUsdcAbi,
    functionName: "confidentialBalanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && addresses.confidentialUSDC) },
  });

  const { data: isOperator, refetch: refetchOperator } = useReadContract({
    address: addresses.confidentialUSDC,
    abi: confidentialUsdcAbi,
    functionName: "isOperator",
    args: address ? [address, addresses.megaPot] : undefined,
    query: { enabled: Boolean(address && addresses.confidentialUSDC) },
  });

  const refetchHandles = useCallback(() => {
    void refetchBalance();
    void refetchRanges();
    void refetchWallet();
    void refetchOperator();
  }, [refetchBalance, refetchRanges, refetchWallet, refetchOperator]);

  /** Sign once, then decrypt this user's balance, odds and wallet holdings. */
  const reveal = useCallback(async () => {
    if (!address || !walletClient) return;
    setBusy(true);
    setError(null);
    try {
      const contracts: Address[] = [addresses.megaPot, addresses.confidentialUSDC];
      const active = session ?? (await createDecryptSession(walletClient, address, contracts));
      setSession(active);

      const pairs: { handle: string; contractAddress: Address }[] = [];
      if (balanceHandle) pairs.push({ handle: balanceHandle as string, contractAddress: addresses.megaPot });
      if (walletHandle) pairs.push({ handle: walletHandle as string, contractAddress: addresses.confidentialUSDC });
      for (const range of (ranges ?? []) as readonly { lower: string; upper: string }[]) {
        pairs.push({ handle: range.lower, contractAddress: addresses.megaPot });
        pairs.push({ handle: range.upper, contractAddress: addresses.megaPot });
      }

      const clear = await userDecrypt(active, pairs);
      const at = (h?: string) => (h ? (clear[h] ?? clear[h.toLowerCase()] ?? 0n) : 0n);

      setBalance(at(balanceHandle as string | undefined));
      setWalletBalance(at(walletHandle as string | undefined));
      setTickets(
        ((ranges ?? []) as readonly { lower: string; upper: string }[]).reduce(
          (sum, r) => sum + (at(r.upper) - at(r.lower)),
          0n,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [address, walletClient, session, balanceHandle, walletHandle, ranges]);

  const clear = useCallback(() => {
    setSession(null);
    setBalance(undefined);
    setTickets(undefined);
    setWalletBalance(undefined);
  }, []);

  const encrypt = useCallback(
    async (amount: bigint) => {
      if (!address) throw new Error("connect a wallet first");
      return encryptAmount(addresses.megaPot, address, amount);
    },
    [address],
  );

  return useMemo(
    () => ({
      address,
      balance,
      tickets,
      walletBalance,
      isOperator: isOperator as boolean | undefined,
      rangeCount: ((ranges ?? []) as readonly unknown[]).length,
      revealed: session !== null,
      busy,
      error,
      reveal,
      clear,
      encrypt,
      refetchHandles,
    }),
    [
      address,
      balance,
      tickets,
      walletBalance,
      isOperator,
      ranges,
      session,
      busy,
      error,
      reveal,
      clear,
      encrypt,
      refetchHandles,
    ],
  );
}
