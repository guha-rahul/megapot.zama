"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";

import { EtaBadge, Guard } from "../../components/Guard";
import { Shell } from "../../components/Shell";
import { AmountField, TxStatus } from "../../components/TxStatus";
import { MEGA, ROUND_STATES, addresses, megaPotAbi } from "../../lib/contracts";
import { formatOdds, formatUsdc, parseUsdc, readableError } from "../../lib/format";
import { ETA, humanDuration } from "../../lib/timing";

/** Absolute timestamps, in the viewer's own locale and zone. */
const stamp = (secs: bigint | number) =>
  new Date(Number(secs) * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
import { useJourney } from "../../lib/useJourney";
import { useNow, usePrivateState, usePublicState } from "../../lib/usePool";
import { useTx } from "../../lib/useTx";
import { poolChain } from "../../lib/wagmi";

/** Your encrypted position — and the two ways out of it. */
export default function PositionPage() {
  const pool = usePublicState();
  const me = usePrivateState();
  const journey = useJourney(me, pool);
  const { address } = useAccount();
  const { run, state, busy } = useTx();
  const [amount, setAmount] = useState("");

  const send = (label: string, fn: "withdraw" | "restake") =>
    run(
      label,
      async () => {
        const { getWalletClient } = await import("../../lib/clients");
        const wc = await getWalletClient();
        if (fn === "restake")
          return wc.writeContract({
            address: addresses.megaPot,
            abi: megaPotAbi,
            functionName: "restake",
            args: [],
            chain: poolChain,
            account: address!,
          });
        const value = parseUsdc(amount || "0");
        if (value === 0n) throw new Error("Enter an amount to withdraw.");
        const { handle, proof } = await me.encrypt(value);
        return wc.writeContract({
          address: addresses.megaPot,
          abi: megaPotAbi,
          functionName: "withdraw",
          args: [handle, proof],
          chain: poolChain,
          account: address!,
        });
      },
      async () => {
        setAmount("");
        me.refetchHandles();
        pool.refetch();
        if (me.revealed) await me.reveal();
      },
    );

  const hidden = <span className="cipher">••••••••</span>;

  return (
    <Shell pool={pool} journey={journey}>
      <div className="page-head">
        <div className="eyebrow">Your account</div>
        <h1>Position</h1>
        <p>
          Every figure here is a ciphertext on-chain. Sign once and they decrypt locally — the
          plaintext never leaves this tab.
        </p>
      </div>

      <Guard journey={journey} need="position">
        <div className="card">
          <div className="card-head">
            <h2>Encrypted holdings</h2>
            <EtaBadge eta={ETA.userDecrypt} />
          </div>
          <div className="row">
            <span className="row-k">Pool balance</span>
            <span className="row-v num">{me.revealed ? `${formatUsdc(me.balance)} USDC` : hidden}</span>
          </div>
          <div className="row">
            <span className="row-k">Your tickets</span>
            <span className="row-v num">{me.revealed ? formatUsdc(me.tickets) : hidden}</span>
          </div>
          <div className="row">
            <span className="row-k">Win chance</span>
            <span className="row-v num" style={{ color: me.revealed ? "var(--gold)" : undefined }}>
              {me.revealed ? formatOdds(me.tickets, pool.settledTickets) : hidden}
            </span>
          </div>
          <div className="row">
            <span className="row-k">Wrapped cUSDC</span>
            <span className="row-v num">
              {me.revealed ? `${formatUsdc(me.walletBalance)} cUSDC` : hidden}
            </span>
          </div>
          <div className="btn-row" style={{ marginTop: 15 }}>
            <button className={me.revealed ? "" : "mint"} style={{ flex: 1 }} disabled={me.busy} onClick={() => void me.reveal()}>
              {me.busy ? "Decrypting…" : me.revealed ? "Refresh" : "Decrypt my position"}
            </button>
            {me.revealed && <button className="ghost" onClick={me.hide}>Hide</button>}
          </div>
          <div className="eta-why">{ETA.userDecrypt.because}</div>
          {me.error && <div className="status status-error">{readableError(me.error)}</div>}
        </div>

        {journey.claimTarget && (
          <div className="status status-win">
            <span>
              {journey.claimTarget.track === MEGA ? "Megapot round" : "Round"} #
              {String(journey.claimTarget.roundId)} is drawn and you were in it.{" "}
              <Link href="/claim" style={{ color: "var(--gold)", fontWeight: 700 }}>
                Claim your result →
              </Link>
            </span>
          </div>
        )}

        <MegapotPosition me={me} pool={pool} />

        <div className="status">
          <span>
            Your principal is never staked, so there is nothing to wait for.{" "}
            <Link href="/withdraw" style={{ color: "var(--gold)", fontWeight: 700 }}>
              Withdraw any amount, any time →
            </Link>
          </span>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Re-stake</h2>
            <EtaBadge eta={ETA.tx} />
          </div>
          <p className="card-hint">
            Re-issue your tickets to cover your <em>whole</em> balance, folding in any prizes you have
            won. Once per round.
          </p>
          <button className="block" disabled={busy} onClick={() => send("Re-staking your balance", "restake")}>
            Re-stake winnings into tickets
          </button>
        </div>

        <TxStatus state={state} />
      </Guard>
    </Shell>
  );
}

/**
 * Your side of the opt-in Megapot game.
 *
 * The main card above answers "what do I hold?" for the main prize only, and the allocation
 * slider lives over on /deposit — so a depositor who opted in had no page that told them their
 * Megapot odds, when that track next draws, or whether they had won it. The track runs its own
 * rounds on its own schedule; it needs its own panel.
 */
function MegapotPosition({
  me,
  pool,
}: {
  me: ReturnType<typeof usePrivateState>;
  pool: ReturnType<typeof usePublicState>;
}) {
  const now = useNow();
  const playing = me.megaRangeCount > 0;
  const round = pool.megaRound;
  const hidden = <span className="cipher">••••••••</span>;

  // Before entries close there is no revealed denominator, so odds are undetermined rather than
  // zero — saying "0.00%" to someone holding tickets would simply be wrong.

  /**
   * A drawn round whose claim window has expired is still `Claimable` on-chain until somebody
   * sweeps it — the sweep is permissionless and nobody is obliged to run it promptly. Printing
   * the raw state then produced "claimable" directly above "claims close: closed", which is a
   * contradiction rather than a status. Past the deadline the round is over, whatever the enum
   * still says, and the honest reading is that it is waiting to be swept.
   */
  const drawn = round !== undefined && round.state >= 4;
  const over = drawn && Number(round!.claimDeadline) <= now;

  /**
   * Odds belong to a round, not to a wallet.
   *
   * Dividing this stake by the latest round's revealed total is only meaningful while that round
   * is live. Once it is over, the stake shown here is waiting for a round that has not opened —
   * its denominator does not exist yet, and reusing the finished one produced a confident
   * percentage against a draw this depositor was never in. "Not yet determined" is the true
   * answer, and `formatOdds` already words it.
   */
  const oddsTotal = round !== undefined && !over ? round.totalTickets : undefined;
  const odds = formatOdds(me.megaTickets, oddsTotal);
  const label =
    round === undefined
      ? "—"
      : over
        ? "closed, awaiting sweep"
        : ROUND_STATES[round.state].toLowerCase();

  return (
    <div className="card">
      <div className="card-head">
        <h2>Megapot prize</h2>
        <span className={playing ? "chip chip-mint" : "chip"}>
          {playing ? "opted in" : "not playing"}
        </span>
      </div>

      {!playing ? (
        <p className="card-hint" style={{ margin: 0 }}>
          This second prize is funded by winnings from the real Megapot jackpot on Base, and it is
          opt-in — you play it only for the share of your stake you allocate.{" "}
          <Link href="/deposit" style={{ color: "var(--gold)", fontWeight: 600 }}>
            Set an allocation →
          </Link>
        </p>
      ) : (
        <>
          <div className="row">
            <span className="row-k">Your Megapot tickets</span>
            <span className="row-v num">{me.revealed ? formatUsdc(me.megaTickets) : hidden}</span>
          </div>
          <div className="row">
            <span className="row-k">Win chance on this track</span>
            <span className="row-v num" style={{ color: me.revealed ? "var(--gold)" : undefined }}>
              {me.revealed ? odds : hidden}
            </span>
          </div>
          <div className="row">
            <span className="row-k">Round</span>
            <span className="row-v">
              {round === undefined ? "—" : `#${String(pool.megaLatestRoundId)} · ${label}`}
            </span>
          </div>
          <div className="row">
            <span className="row-k">{over ? "Status" : drawn ? "Claims close" : "Draws"}</span>
            <span className="row-v num">
              {round === undefined
                ? "—"
                : over
                  ? "waiting for the next round to open"
                  : drawn
                    ? `in ${humanDuration(Number(round.claimDeadline) - now)}`
                    : Number(round.drawTime) > now
                      ? `in ${humanDuration(Number(round.drawTime) - now)}`
                      : "ready — waiting on the keeper"}
            </span>
          </div>
          {/* Once a round is over, a countdown has nothing left to count. What is actually useful
              then is when the thing happened, so the depositor can line it up against their own
              transactions — a relative "3h ago" cannot be matched to a block explorer. */}
          {drawn && (
            <div className="row">
              <span className="row-k">Drawn</span>
              <span className="row-v">{stamp(round!.drawTime)}</span>
            </div>
          )}
          {drawn && Number(round!.claimDeadline) > 0 && (
            <div className="row">
              <span className="row-k">{over ? "Claims closed" : "Claims close"}</span>
              <span className="row-v">{stamp(round!.claimDeadline)}</span>
            </div>
          )}
          <p className="card-hint" style={{ marginTop: 12 }}>
            Rounds are opened by a keeper, each with a draw time chosen when it opens — your
            tickets keep their place in between, so a depositor from an earlier round automatically
            plays the next one.{" "}
            <Link href="/deposit" style={{ color: "var(--gold)", fontWeight: 600 }}>
              Change your allocation →
            </Link>{" "}
            ·{" "}
            <Link href="/rounds" style={{ color: "var(--gold)", fontWeight: 600 }}>
              See both tracks&apos; history →
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
