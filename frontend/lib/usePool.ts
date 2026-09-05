"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { useAccount, useReadContract, useReadContracts, useWalletClient } from "wagmi";

import { BASE_SEPOLIA_ID, MAIN, MEGA, addresses, confidentialUsdcAbi, erc20Abi, jackpotAbi, megaPotAbi, ticketAgentAbi } from "./contracts";
import { createDecryptSession, encryptAmount, userDecrypt, type DecryptSession } from "./zama";

/**
 * How often public pool state is re-read.
 *
 * Sepolia blocks land every ~12s, so polling faster than this cannot see anything new — it only
 * spends rate limit. On free RPC endpoints that limit is the scarce resource, and a tab left open
 * is the biggest consumer of it, so this errs slower than the block time rather than faster.
 * Anything the user themselves causes is refetched explicitly at the end of the transaction.
 */
const REFRESH = 20_000;

/** What one `reveal()` decrypted, returned so callers can diff two of them. */
export type Snapshot = { balance: bigint; walletBalance: bigint; tickets: bigint; megaTickets: bigint };

/** A ticking clock, so countdowns move without re-fetching anything. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export type RoundView = {
  drawTime: bigint;
  claimDeadline: bigint;
  totalTickets: bigint;
  prize: bigint;
  state: number;
  cursorSnapshot: string;
  ticket: string;
  unclaimed: string;
};

/** Everything the pool publishes in the clear, on Ethereum Sepolia. */
export function usePublicState() {
  const base = { address: addresses.megaPot, abi: megaPotAbi } as const;
  const enabled = Boolean(addresses.megaPot);

  const { data, refetch, isLoading, isError, error: readError } = useReadContracts({
    contracts: [
      { ...base, functionName: "prizeReserve" },
      { ...base, functionName: "settledTickets" },
      { ...base, functionName: "deployedPrincipal" },
      { ...base, functionName: "roundsLength", args: [MAIN] },
      { ...base, functionName: "entryRound" },
      { ...base, functionName: "depositsPaused" },
      { ...base, functionName: "megapotShareBps" },
      { ...base, functionName: "ticketBudget" },
    ],
    query: { refetchInterval: REFRESH, refetchIntervalInBackground: false, enabled },
  });

  const roundsLength = (data?.[3]?.result as bigint | undefined) ?? 0n;
  const latestRoundId = roundsLength > 0n ? roundsLength - 1n : undefined;

  const { data: round, refetch: refetchRound } = useReadContract({
    ...base,
    functionName: "getRound",
    args: latestRoundId !== undefined ? [MAIN, latestRoundId] : undefined,
    query: { enabled: enabled && latestRoundId !== undefined, refetchInterval: REFRESH },
  });

  // A chain read that fails is not the same as one that returned nothing, and the app has to be
  // able to tell the user which happened. Without this every RPC failure renders as an em dash.
  const unreachable = isError
    ? readError instanceof Error
      ? readError.message
      : "The RPC did not answer."
    : null;

  return {
    isLoading,
    unreachable,
    prizeReserve: data?.[0]?.result as bigint | undefined,
    settledTickets: data?.[1]?.result as bigint | undefined,
    deployedPrincipal: data?.[2]?.result as bigint | undefined,
    roundsLength,
    entryRound: data?.[4]?.result as bigint | undefined,
    depositsPaused: data?.[5]?.result as boolean | undefined,
    megapotShareBps: data?.[6]?.result as number | undefined,
    ticketBudget: data?.[7]?.result as bigint | undefined,
    latestRoundId,
    round: round as RoundView | undefined,
    refetch: () => {
      void refetch();
      void refetchRound();
    },
  };
}

/** The Megapot leg on Base Sepolia — the pool's real lottery position. */
export function useMegapotLeg() {
  const enabled = Boolean(addresses.ticketAgent && addresses.jackpot);

  const { data } = useReadContracts({
    contracts: [
      { address: addresses.ticketAgent, abi: ticketAgentAbi, functionName: "totalSpent", chainId: BASE_SEPOLIA_ID },
      { address: addresses.ticketAgent, abi: ticketAgentAbi, functionName: "totalWon", chainId: BASE_SEPOLIA_ID },
      {
        address: addresses.ticketAgent,
        abi: ticketAgentAbi,
        functionName: "ticketsHeldBps",
        chainId: BASE_SEPOLIA_ID,
      },
      { address: addresses.ticketAgent, abi: ticketAgentAbi, functionName: "claimable", chainId: BASE_SEPOLIA_ID },
      { address: addresses.ticketAgent, abi: ticketAgentAbi, functionName: "roundEndsAt", chainId: BASE_SEPOLIA_ID },
      {
        address: addresses.ticketAgent,
        abi: ticketAgentAbi,
        functionName: "totalReferralFees",
        chainId: BASE_SEPOLIA_ID,
      },
      { address: addresses.jackpot, abi: jackpotAbi, functionName: "feeBps", chainId: BASE_SEPOLIA_ID },
      { address: addresses.jackpot, abi: jackpotAbi, functionName: "userPoolTotal", chainId: BASE_SEPOLIA_ID },
      {
        address: addresses.jackpot,
        abi: jackpotAbi,
        functionName: "ticketCountTotalBps",
        chainId: BASE_SEPOLIA_ID,
      },
      { address: addresses.jackpot, abi: jackpotAbi, functionName: "lpPoolTotal", chainId: BASE_SEPOLIA_ID },
      { address: addresses.ticketAgent, abi: ticketAgentAbi, functionName: "totalBridged", chainId: BASE_SEPOLIA_ID },
      // The only honest proof that value crossed FROM the pool: bridged USDC sitting on the agent.
      // `totalBridged` counts the agent's own outbound `bridgeHome`, which is the return leg.
      { address: addresses.usdcBase, abi: erc20Abi, functionName: "balanceOf", args: [addresses.ticketAgent], chainId: BASE_SEPOLIA_ID },
    ],
    query: { refetchInterval: REFRESH, refetchIntervalInBackground: false, enabled },
  });

  const heldBps = data?.[2]?.result as bigint | undefined;
  const totalBps = data?.[8]?.result as bigint | undefined;

  return {
    totalSpent: data?.[0]?.result as bigint | undefined,
    totalWon: data?.[1]?.result as bigint | undefined,
    heldBps,
    claimable: data?.[3]?.result as bigint | undefined,
    roundEndsAt: data?.[4]?.result as bigint | undefined,
    referralFees: data?.[5]?.result as bigint | undefined,
    feeBps: data?.[6]?.result as bigint | undefined,
    userPoolTotal: data?.[7]?.result as bigint | undefined,
    totalBps,
    lpPoolTotal: data?.[9]?.result as bigint | undefined,
    /** Value the agent has sent *home* over CCTP (the return leg). */
    totalBridged: data?.[10]?.result as bigint | undefined,
    /** Bridged USDC now held on Base — proof the burn AND the mint both happened. */
    arrivedOnBase: data?.[11]?.result as bigint | undefined,
    /** The pool's share of the live Megapot round, as a fraction. */
    share: heldBps !== undefined && totalBps ? Number(heldBps) / Number(totalBps) : undefined,
  };
}

/**
 * The private half: ciphertext handles the pool published for this user, and the single signature
 * that unlocks reading them locally.
 */
export function usePrivateState() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [session, setSession] = useState<DecryptSession | null>(null);
  // The session also lives in a ref so two `reveal()` calls from the same closure reuse one
  // signature. Reading it off state would show `null` to the second call and prompt the wallet again.
  const sessionRef = useRef<DecryptSession | null>(null);
  const [balance, setBalance] = useState<bigint | undefined>();
  const [tickets, setTickets] = useState<bigint | undefined>();
  const [megaTickets, setMegaTickets] = useState<bigint | undefined>();
  const [walletBalance, setWalletBalance] = useState<bigint | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forUser = { args: address ? ([address] as const) : undefined, query: { enabled: Boolean(address) } };

  const { data: balanceHandle, refetch: refetchBalance } = useReadContract({
    address: addresses.megaPot,
    abi: megaPotAbi,
    functionName: "confidentialBalanceOf",
    ...forUser,
  });

  const { data: ranges, refetch: refetchRanges } = useReadContract({
    address: addresses.megaPot,
    abi: megaPotAbi,
    functionName: "rangesOf",
    args: address ? ([MAIN, address] as const) : undefined,
    query: { enabled: Boolean(address) },
  });

  const { data: megaRanges, refetch: refetchMega } = useReadContract({
    address: addresses.megaPot,
    abi: megaPotAbi,
    functionName: "rangesOf",
    args: address ? ([MEGA, address] as const) : undefined,
    query: { enabled: Boolean(address) },
  });

  const { data: walletHandle, refetch: refetchWallet } = useReadContract({
    address: addresses.confidentialUSDC,
    abi: confidentialUsdcAbi,
    functionName: "confidentialBalanceOf",
    ...forUser,
  });

  const { data: isOperator, refetch: refetchOperator } = useReadContract({
    address: addresses.confidentialUSDC,
    abi: confidentialUsdcAbi,
    functionName: "isOperator",
    args: address ? [address, addresses.megaPot] : undefined,
    query: { enabled: Boolean(address) },
  });

  const { data: usdcBalance, refetch: refetchUsdc } = useReadContract({
    address: addresses.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    ...forUser,
  });

  const refetchHandles = useCallback(() => {
    void refetchBalance();
    void refetchRanges();
    void refetchMega();
    void refetchWallet();
    void refetchOperator();
    void refetchUsdc();
  }, [refetchBalance, refetchRanges, refetchMega, refetchWallet, refetchOperator, refetchUsdc]);

  /**
   * Sign once, then decrypt this user's balance, odds and wrapped holdings — all in-browser.
   *
   * Returns the snapshot as well as storing it. A caller that decrypts either side of a
   * transaction — the claim page comparing before with after — cannot read the result off the hook,
   * because its `me` object is the one captured when the handler was created and `setBalance` only
   * affects the *next* render. Handles are re-read here rather than taken from the closure for the
   * same reason: after a claim the cached handle still points at the pre-claim ciphertext.
   */
  const reveal = useCallback(async (): Promise<Snapshot | undefined> => {
    if (!address || !walletClient) return undefined;
    setBusy(true);
    setError(null);
    try {
      const contracts: Address[] = [addresses.megaPot, addresses.confidentialUSDC];
      const active = sessionRef.current ?? (await createDecryptSession(walletClient, address, contracts));
      sessionRef.current = active;
      setSession(active);

      const [balRes, rangeRes, walRes, megaRes] = await Promise.all([
        refetchBalance(),
        refetchRanges(),
        refetchWallet(),
        refetchMega(),
      ]);
      const bHandle = (balRes.data ?? balanceHandle) as string | undefined;
      const wHandle = (walRes.data ?? walletHandle) as string | undefined;
      const rows = (rangeRes.data ?? ranges ?? []) as readonly { lower: string; upper: string }[];
      const megaRows = (megaRes.data ?? megaRanges ?? []) as readonly { lower: string; upper: string }[];

      const pairs: { handle: string; contractAddress: Address }[] = [];
      if (bHandle) pairs.push({ handle: bHandle, contractAddress: addresses.megaPot });
      if (wHandle) pairs.push({ handle: wHandle, contractAddress: addresses.confidentialUSDC });
      for (const range of [...rows, ...megaRows]) {
        pairs.push({ handle: range.lower, contractAddress: addresses.megaPot });
        pairs.push({ handle: range.upper, contractAddress: addresses.megaPot });
      }

      const clear = await userDecrypt(active, pairs);
      const at = (h?: string) => (h ? (clear[h] ?? clear[h.toLowerCase()] ?? 0n) : 0n);

      const snapshot: Snapshot = {
        balance: at(bHandle),
        walletBalance: at(wHandle),
        tickets: rows.reduce((sum, r) => sum + (at(r.upper) - at(r.lower)), 0n),
        megaTickets: megaRows.reduce((sum, r) => sum + (at(r.upper) - at(r.lower)), 0n),
      };
      setBalance(snapshot.balance);
      setWalletBalance(snapshot.walletBalance);
      setTickets(snapshot.tickets);
      setMegaTickets(snapshot.megaTickets);
      return snapshot;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      sessionRef.current = null;
      setSession(null);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [
    address,
    walletClient,
    balanceHandle,
    walletHandle,
    ranges,
    refetchBalance,
    refetchRanges,
    refetchWallet,
    refetchMega,
    megaRanges,
  ]);

  /**
   * Decrypt one `euint64` the pool has granted to this address, reusing the reveal session.
   *
   * The handle is read imperatively rather than through a cached `useReadContract` for the same
   * reason `reveal` re-reads its own: right after the transaction that produced it, the cached
   * value is still the pre-transaction one, so a decrypt would faithfully return a stale zero.
   *
   * Sharing `sessionRef` with `reveal` is what keeps this to one EIP-712 signature per visit
   * rather than one per question asked.
   */
  const revealHandle = useCallback(
    async (fn: "awardOf" | "lastWithdrawnOf", args: readonly unknown[]): Promise<bigint | undefined> => {
      if (!address || !walletClient) return undefined;
      setBusy(true);
      setError(null);
      try {
        const { getPublicClient } = await import("./clients");
        const handle = (await getPublicClient().readContract({
          address: addresses.megaPot,
          abi: megaPotAbi,
          functionName: fn,
          args: args as never,
        })) as string;

        const active =
          sessionRef.current ??
          (await createDecryptSession(walletClient, address, [addresses.megaPot, addresses.confidentialUSDC]));
        sessionRef.current = active;
        setSession(active);

        const clear = await userDecrypt(active, [{ handle, contractAddress: addresses.megaPot }]);
        return clear[handle] ?? clear[handle.toLowerCase()] ?? 0n;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [address, walletClient],
  );

  /**
   * What you won in a round — from its own handle, not a balance diff.
   *
   * Every claimer gets one of these, and a loser's decrypts to zero. So asking the question
   * reveals nothing about the answer: holding an award handle is not evidence of having won.
   */
  const revealAward = useCallback(
    (track: number, roundId: bigint) => revealHandle("awardOf", [track, roundId, address]),
    [revealHandle, address],
  );

  /** What your last withdrawal actually paid out — the buffer may have been short. */
  const revealLastWithdrawn = useCallback(
    () => revealHandle("lastWithdrawnOf", [address]),
    [revealHandle, address],
  );

  const hide = useCallback(() => {
    sessionRef.current = null;
    setSession(null);
    setBalance(undefined);
    setTickets(undefined);
    setMegaTickets(undefined);
    setWalletBalance(undefined);
  }, []);

  const encrypt = useCallback(
    async (amount: bigint) => {
      if (!address) throw new Error("Connect a wallet first.");
      return encryptAmount(addresses.megaPot, address, amount);
    },
    [address],
  );

  return useMemo(
    () => ({
      address,
      balance,
      tickets,
      megaTickets,
      walletBalance,
      revealAward,
      revealLastWithdrawn,
      usdcBalance: usdcBalance as bigint | undefined,
      balanceHandle: balanceHandle as string | undefined,
      isOperator: isOperator as boolean | undefined,
      hasWrapped: walletHandle !== undefined && walletHandle !== "0x" + "0".repeat(64),
      rangeCount: ((ranges ?? []) as readonly unknown[]).length,
      revealed: session !== null,
      busy,
      error,
      reveal,
      hide,
      encrypt,
      refetchHandles,
    }),
    [
      address,
      balance,
      tickets,
      megaTickets,
      walletBalance,
      revealAward,
      revealLastWithdrawn,
      usdcBalance,
      balanceHandle,
      isOperator,
      walletHandle,
      ranges,
      session,
      busy,
      error,
      reveal,
      hide,
      encrypt,
      refetchHandles,
    ],
  );
}

export type PublicState = ReturnType<typeof usePublicState>;
export type PrivateState = ReturnType<typeof usePrivateState>;
export type MegapotLeg = ReturnType<typeof useMegapotLeg>;

/** Whether the connected user has already claimed a given round. */
export function useHasClaimed(roundId: bigint | undefined, user?: Address, track: number = MAIN) {
  const { data, refetch } = useReadContract({
    address: addresses.megaPot,
    abi: megaPotAbi,
    functionName: "hasClaimed",
    args: roundId !== undefined && user ? [track, roundId, user] : undefined,
    query: { enabled: roundId !== undefined && Boolean(user) },
  });
  return { hasClaimed: data as boolean | undefined, refetch };
}
