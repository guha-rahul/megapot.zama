"use client";

import { useEffect, useState } from "react";
import { useAccount, useReadContract } from "wagmi";

import { MEGA, addresses, megaPotAbi } from "../lib/contracts";
import { formatUsdc, readableError } from "../lib/format";
import { useMegapotLeg, type PrivateState } from "../lib/usePool";
import { useTx } from "../lib/useTx";
import { poolChain } from "../lib/wagmi";
import { TxStatus } from "./TxStatus";

/** Whole-percent stops. Coarse buckets are a privacy decision — see the note in the card. */
const STEP = 25;

/**
 * How much of your yield plays the jackpot.
 *
 * The framing rule for this whole component: a slider with one labelled end reads as a risk dial,
 * so both destinations are always named. Nothing here is a wager on principal, and the copy has to
 * carry that without the user having to trust us about it.
 */
export function Allocation({ me }: { me: PrivateState }) {
  const { address } = useAccount();
  const leg = useMegapotLeg();
  const { run, state, busy } = useTx();

  const { data: onChain, refetch } = useReadContract({
    address: addresses.megaPot,
    abi: megaPotAbi,
    functionName: "megapotBps",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const { data: canChange } = useReadContract({
    address: addresses.megaPot,
    abi: megaPotAbi,
    functionName: "canCompact",
    args: address ? [MEGA, address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const saved = Number(onChain ?? 0n) / 100;
  const [pct, setPct] = useState(saved);
  useEffect(() => setPct(saved), [saved]);

  const dirty = pct !== saved;
  const raising = pct > saved;
  const blocked = raising && canChange === false;

  const save = () =>
    run(
      `Allocating ${pct}% to Megapot`,
      async () => {
        const { getWalletClient } = await import("../lib/clients");
        const wc = await getWalletClient();
        return wc.writeContract({
          address: addresses.megaPot,
          abi: megaPotAbi,
          functionName: "setMegapotAllocation",
          args: [pct * 100],
          chain: poolChain,
          account: address!,
        });
      },
      async () => {
        await refetch();
        me.refetchHandles();
      },
    );

  // Two independent draws compose: the pool's tickets must hit the jackpot, and then you must be
  // the depositor the encrypted draw picks. Showing only one of them would overstate the odds.
  const poolShare = leg.share;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Megapot allocation</h2>
        <span className="chip chip-gold">optional</span>
      </div>

      <p className="card-hint">
        Your principal is never staked. Not at 0%, not at 100%. What this moves is where your{" "}
        <em>yield</em> goes — into the steady main prize, or into buying tickets on Megapot&apos;s
        much larger jackpot over on Base.
      </p>

      <div className="alloc-value num">{pct}%</div>
      <input
        className="slider"
        type="range"
        min={0}
        max={100}
        step={STEP}
        value={pct}
        onChange={(e) => setPct(Number(e.target.value))}
        aria-label="Share of your yield spent on Megapot tickets"
      />

      <div className="alloc-split">
        <div>
          <div className="stat-k">Main prize</div>
          <div className="stat-v num">{100 - pct}% of your yield</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="stat-k">Megapot tickets</div>
          <div className="stat-v num">{pct}% of your yield</div>
        </div>
      </div>

      {pct === 0 && (
        <div className="status">
          0% is a complete answer, not an unset one — you are still in the main draw with every
          ticket you hold.
        </div>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <span className="row-k">Live jackpot</span>
        <span className="row-v num">{formatUsdc(leg.userPoolTotal)} USDC</span>
      </div>
      <div className="row">
        <span className="row-k">Pool&apos;s share of the round</span>
        <span className="row-v num">
          {poolShare === undefined ? "—" : `${(Number(poolShare) / 100).toFixed(2)}%`}
        </span>
      </div>
      <div className="row">
        <span className="row-k">Megapot&apos;s house edge</span>
        <span className="row-v num">
          {leg.feeBps === undefined ? "—" : `${Number(leg.feeBps) / 100}%`}
        </span>
      </div>
      <div className="row">
        <span className="row-k">Your Megapot tickets</span>
        <span className="row-v">
          {me.revealed ? (
            <span className="num">{formatUsdc(me.megaTickets, 0)}</span>
          ) : (
            <span className="cipher">encrypted — decrypt on Position</span>
          )}
        </span>
      </div>

      <button
        className="primary block"
        style={{ marginTop: 15 }}
        disabled={busy || !dirty || blocked}
        onClick={save}
      >
        {!dirty ? `Saved — ${saved}%` : blocked ? "Already changed this round" : `Set to ${pct}%`}
      </button>

      {blocked && (
        <div className="status">
          Raising your allocation mints new tickets, and minting is capped at once per round —
          that cap is what stops the ticket space being inflated until every draw rolls over.
          Lowering is always allowed.
        </div>
      )}

      <div className="status">
        <span>
          <strong style={{ color: "var(--text)" }}>This number is public.</strong> Unlike everything
          else here, your allocation is on-chain in the clear: anyone can see you chose {pct}%, and
          nobody can see {pct}% <em>of what</em>. Your balance, your tickets and your winnings stay
          encrypted. It has to be public because the yield split is computed from the two tracks&apos;
          plaintext ticket totals, and that ratio is the only thing keeping the split fair between
          depositors who opted in and those who did not. It snaps to quarters so your choice looks
          like other people&apos;s rather than becoming a fingerprint.
        </span>
      </div>

      <div className="status">
        Megapot takes {leg.feeBps === undefined ? "a" : `${Number(leg.feeBps) / 100}%`} of every
        ticket, so a unit of yield played returns less than a unit in expectation. You are buying
        variance, not edge — a rarer shot at a much bigger number, with your deposit untouched
        either way.
      </div>

      {me.error && <div className="status status-error">{readableError(me.error)}</div>}
      <TxStatus state={state} />
    </div>
  );
}
