"use client";

import { useState } from "react";
import { useAccount } from "wagmi";

import { Countdown, EtaBadge, Guard } from "../../components/Guard";
import { Shell } from "../../components/Shell";
import { TxStatus } from "../../components/TxStatus";
import { addresses, megaPotAbi } from "../../lib/contracts";
import { formatUsdc } from "../../lib/format";
import { ETA } from "../../lib/timing";
import { useJourney } from "../../lib/useJourney";
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
   * The award is never a handle of its own — it lands inside the encrypted balance. So the only
   * way to learn the outcome is to decrypt either side of the claim and diff. Both snapshots must
   * come from `reveal()`'s return value; the hook's `me.balance` is frozen at the render that built
   * this handler. The pre-claim decrypt reuses the existing session, so it costs no extra signature.
   */
  const claim = async () => {
    setState({ text: "Decrypting your balance before the claim…", busy: true });
    const before = await me.reveal();
    if (!before) {
      setState({ text: me.error ?? "Could not decrypt your balance.", kind: "error" });
      return;
    }

    await run(
      `Claiming round #${pool.latestRoundId}`,
      async () => {
        const { getWalletClient } = await import("../../lib/clients");
        const wc = await getWalletClient();
        return wc.writeContract({
          address: addresses.megaPot,
          abi: megaPotAbi,
          functionName: "claim",
          args: [pool.latestRoundId!],
          chain: poolChain,
          account: address!,
        });
      },
      async () => {
        setState({ text: "Decrypting your balance to see the result…", busy: true });
        const after = await me.reveal();
        pool.refetch();
        if (after && after.balance > before.balance) {
          const won = after.balance - before.balance;
          setOutcome({ won: true, amount: won });
          setState({ text: `🎉 You won ${formatUsdc(won)} USDC — visible only to you.`, kind: "win" });
        } else {
          setOutcome({ won: false, amount: 0n });
          setState({ text: "Claimed — no win this round. Only you can see that." });
        }
      },
    );
  };

  return (
    <Shell pool={pool} journey={journey}>
      <div className="page-head">
        <div className="eyebrow">Step 3</div>
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
                ? `Your balance rose by ${formatUsdc(outcome.amount)} USDC. On-chain this is indistinguishable from a losing claim — an observer sees the same call and the same events.`
                : "Your balance is unchanged. Your principal is untouched — that is the whole point of a no-loss lottery."}
            </p>
          </div>
        )}

        <TxStatus state={state} />
      </Guard>
    </Shell>
  );
}
