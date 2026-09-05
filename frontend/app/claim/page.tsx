"use client";

import { useState } from "react";
import { useAccount } from "wagmi";

import { Countdown, EtaBadge, Guard } from "../../components/Guard";
import { Shell } from "../../components/Shell";
import { TxStatus } from "../../components/TxStatus";
import { MAIN, addresses, megaPotAbi } from "../../lib/contracts";
import { formatUsdc } from "../../lib/format";
import { ETA } from "../../lib/timing";
import { stepNumber, useJourney } from "../../lib/useJourney";
import { usePrivateState, usePublicState } from "../../lib/usePool";
import { useTx } from "../../lib/useTx";
import { poolChain } from "../../lib/wagmi";

/**
 * The moment of truth.
 *
 * The point worth making on this page is that the transaction is identical either way — the user
 * has to decrypt their own balance to learn the outcome, and so does everyone else, which is why
 * nobody else can.
 */
export default function ClaimPage() {
  const pool = usePublicState();
  const me = usePrivateState();
  const journey = useJourney(me, pool);
  const { address } = useAccount();
  const { run, state, setState, busy } = useTx();
  const [outcome, setOutcome] = useState<{ won: boolean; amount: bigint } | null>(null);

  const round = pool.round;

  /**
   * The claim writes an award handle for *every* claimer, readable only by them, and a loser's
   * decrypts to zero. So the outcome is one direct decryption — no diffing balances either side,
   * and no wallet round-trip before the transaction.
   *
   * That the question is safe to ask is the point: holding an award handle, or being seen to
   * decrypt one, says nothing about whether you won.
   */
  const claim = async () => {
    await run(
      `Claiming round #${pool.latestRoundId}`,
      async () => {
        const { getWalletClient } = await import("../../lib/clients");
        const wc = await getWalletClient();
        return wc.writeContract({
          address: addresses.megaPot,
          abi: megaPotAbi,
          functionName: "claim",
          args: [MAIN, pool.latestRoundId!],
          chain: poolChain,
          account: address!,
        });
      },
      async () => {
        setState({ text: "Decrypting your award…", busy: true });
        const award = await me.revealAward(MAIN, pool.latestRoundId!);
        pool.refetch();
        me.refetchHandles();

        if (award === undefined) {
          setState({ text: me.error ?? "Claimed, but the award could not be decrypted.", kind: "error" });
          return;
        }
        if (award > 0n) {
          setOutcome({ won: true, amount: award });
          setState({ text: `🎉 You won ${formatUsdc(award)} USDC — visible only to you.`, kind: "win" });
        } else {
          setOutcome({ won: false, amount: 0n });
          setState({ text: "Claimed — no win this round. Only you can see that." });
        }
        if (me.revealed) await me.reveal();
      },
    );
  };

  return (
    <Shell pool={pool} journey={journey}>
      <div className="page-head">
        <div className="eyebrow">Step {stepNumber("claim")}</div>
        <h1>Claim your result</h1>
        <p>
          Winning and losing are the <strong style={{ color: "var(--text)" }}>same transaction</strong> —
          same call, same gas, same events, same storage shape. The only way to learn which one you
          made is to decrypt your own balance.
        </p>
      </div>

      <Guard journey={journey} need="position">
        <div className="card">
          <div className="card-head">
            <h2>Round #{pool.latestRoundId !== undefined ? String(pool.latestRoundId) : "—"}</h2>
            <EtaBadge eta={ETA.tx} />
          </div>

          <div className="row">
            <span className="row-k">Prize</span>
            <span className="row-v num">{formatUsdc(round?.prize)} USDC</span>
          </div>
          <div className="row">
            <span className="row-k">Tickets in the draw</span>
            <span className="row-v num">{formatUsdc(round?.totalTickets, 0)}</span>
          </div>
          <div className="row">
            <span className="row-k">Winning ticket</span>
            <span className="row-v">
              <span className="cipher">encrypted — nobody can read it</span>
            </span>
          </div>
          {round && Number(round.claimDeadline) > 0 && (
            <div className="row">
              <span className="row-k">Claim window closes</span>
              <span className="row-v">
                <Countdown to={Number(round.claimDeadline)} from={Number(round.drawTime)} done="closed" />
              </span>
            </div>
          )}

          <button
            className="primary block"
            style={{ marginTop: 16 }}
            disabled={busy || !journey.claimable}
            onClick={claim}
          >
            {journey.hasClaimed
              ? `Already claimed round #${pool.latestRoundId}`
              : journey.claimable
                ? `Claim round #${pool.latestRoundId}`
                : "Nothing to claim right now"}
          </button>

          {!journey.claimable && !journey.hasClaimed && (
            <div className="status">
              {round === undefined
                ? "No round has run yet."
                : round.state < 4
                  ? "This round has not been drawn yet. Come back after the draw."
                  : "You had no tickets in this round."}
            </div>
          )}
        </div>

        {outcome && (
          <div className={`card ${outcome.won ? "" : ""}`}>
            <div className="card-head">
              <h2>{outcome.won ? "You won" : "Not this time"}</h2>
              <span className="chip chip-mint">only you can see this</span>
            </div>
            <p className="card-hint" style={{ margin: "6px 0 0" }}>
              {outcome.won
                ? `${formatUsdc(outcome.amount)} USDC, decrypted from an award handle the contract granted to your address alone. On-chain this is indistinguishable from a losing claim — same call, same gas, same events.`
                : "Your award handle decrypted to zero. You still hold one, exactly as a winner does — which is why holding one proves nothing. Your principal is untouched."}
            </p>
          </div>
        )}

        <TxStatus state={state} />
      </Guard>
    </Shell>
  );
}
