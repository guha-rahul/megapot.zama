"use client";

import { useAccount } from "wagmi";

import { useHasClaimed, type PrivateState, type PublicState } from "./usePool";
import { poolChain } from "./wagmi";

/** The ordered steps a depositor moves through. Routes and guards both key off this. */
export const STEPS = [
  { key: "connect", label: "Connect", href: "/" },
  { key: "setup", label: "Setup", href: "/setup" },
  { key: "deposit", label: "Deposit", href: "/deposit" },
  { key: "position", label: "Position", href: "/position" },
  { key: "claim", label: "Claim", href: "/claim" },
  { key: "withdraw", label: "Withdraw", href: "/withdraw" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];

/**
 * A step's position in the rail, 1-based.
 *
 * Page headings used to hard-code these, which is how "Step 4" ended up above a rail that showed
 * Withdraw as step 6. Deriving it means adding a step renumbers the headings for free.
 */
export const stepNumber = (key: StepKey) => STEPS.findIndex((s) => s.key === key) + 1;

/**
 * Where the user actually is, derived from chain state rather than remembered in the client.
 *
 * Splitting the flow across routes means someone can deep-link into the middle of it. Every page
 * asks this hook what is true and refuses politely rather than failing at a button press.
 */
export function useJourney(me: PrivateState, pool: PublicState) {
  const { isConnected, chainId } = useAccount();
  const { hasClaimed } = useHasClaimed(pool.latestRoundId, me.address);

  const wrongChain = isConnected && chainId !== poolChain.id;
  const connected = isConnected && !wrongChain;

  // Ticket ranges are public, so "have they deposited?" needs no decryption.
  const hasDeposited = me.rangeCount > 0;
  const hasWrapped = me.hasWrapped;
  const authorised = me.isOperator === true;
  const setupDone = hasWrapped && authorised;

  const round = pool.round;
  const roundOpen = round !== undefined && round.state === 4;
  const claimable = roundOpen && hasClaimed === false && hasDeposited;

  const current: StepKey = !connected
    ? "connect"
    : !setupDone
      ? "setup"
      : !hasDeposited
        ? "deposit"
        : claimable
          ? "claim"
          : "position";

  const done: Record<StepKey, boolean> = {
    connect: connected,
    setup: setupDone,
    deposit: hasDeposited,
    position: hasDeposited,
    claim: hasClaimed === true,
    // Deliberately never "done". Withdrawing is not a milestone you pass but a door that stays
    // open — marking it complete would imply the opposite of what the pool guarantees.
    withdraw: false,
  };

  return {
    connected,
    wrongChain,
    hasWrapped,
    authorised,
    setupDone,
    hasDeposited,
    claimable,
    hasClaimed,
    roundOpen,
    current,
    done,
    /** What a page needs before it can do anything useful. */
    blocker(need: StepKey): { reason: string; href: string; cta: string } | null {
      if (!connected)
        return {
          reason: wrongChain
            ? `Your wallet is on the wrong network. The pool lives on ${poolChain.name}.`
            : "Connect a wallet to continue.",
          href: "/",
          cta: wrongChain ? "Switch network" : "Go to the start",
        };
      if (need === "connect") return null;

      if (!setupDone && need !== "setup")
        return {
          reason: !hasWrapped
            ? "You need confidential cUSDC before you can deposit. Wrapping takes one transaction."
            : "The pool needs your permission to move cUSDC on your behalf.",
          href: "/setup",
          cta: "Finish setup",
        };
      if (need === "setup" || need === "deposit") return null;

      if (!hasDeposited)
        return {
          reason: "You have no position in the pool yet.",
          href: "/deposit",
          cta: "Make a deposit",
        };
      return null;
    },
  };
}

export type Journey = ReturnType<typeof useJourney>;
