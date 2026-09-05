"use client";

import { useState } from "react";
import { useAccount } from "wagmi";

import { EtaBadge, Guard } from "../../components/Guard";
import { Shell } from "../../components/Shell";
import { AmountField, TxStatus } from "../../components/TxStatus";
import { addresses, megaPotAbi } from "../../lib/contracts";
import { checkAmount, formatUsdc, parseUsdc, readableError } from "../../lib/format";
import { ETA } from "../../lib/timing";
import { useJourney } from "../../lib/useJourney";
import { usePrivateState, usePublicState } from "../../lib/usePool";
import { useTx } from "../../lib/useTx";
import { poolChain } from "../../lib/wagmi";

/**
 * The exit.
 *
 * This is the promise the whole design rests on — principal is never staked, so it is always
 * yours — and it deserves its own step rather than a card at the bottom of another page.
 *
 * The honest complication is that the payout comes from the pool's confidential cUSDC buffer,
 * whose balance is `allowThis`-only: nobody, including this app, can decrypt it. So we genuinely
 * cannot tell you in advance whether a withdrawal will fill. What we can do is show you exactly
 * what landed afterwards, by decrypting `lastWithdrawnOf` — a handle only you can read.
 */
export default function WithdrawPage() {
  const pool = usePublicState();
  const me = usePrivateState();
  const journey = useJourney(me, pool);
  const { address } = useAccount();
  const { run, state, busy } = useTx();
  const [amount, setAmount] = useState("");
  const [paid, setPaid] = useState<{ asked: bigint; got: bigint } | null>(null);

  const value = parseUsdc(amount || "0");
  const problem = amount ? checkAmount(value, me.revealed ? me.balance : undefined, "cUSDC") : null;

  const withdraw = () =>
    run(
      "Encrypting and withdrawing",
      async () => {
        const { getWalletClient } = await import("../../lib/clients");
        const wc = await getWalletClient();
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
        const asked = value;
        setAmount("");
        me.refetchHandles();
        pool.refetch();

        // The one number that closes the partial-fill loop honestly.
        const got = await me.revealLastWithdrawn();
        if (got !== undefined) setPaid({ asked, got });
        if (me.revealed) await me.reveal();
      },
    );

  return (
    <Shell pool={pool} journey={journey}>
      <div className="page-head">
        <div className="eyebrow">Step 4</div>
        <h1>Withdraw — any time</h1>
        <p>
          Your principal is <strong style={{ color: "var(--text)" }}>never staked</strong>. Only the
          yield is ever played, so there is no round to wait for and no lock-up to clear. Take it
          whenever you like.
        </p>
      </div>

      <Guard journey={journey} need="position">
        <div className="card">
          <div className="card-head">
            <h2>Withdraw</h2>
            <EtaBadge eta={ETA.tx} />
          </div>
          <p className="card-hint">
            The amount is encrypted in your browser, and the payout comes out of the pool&apos;s
            confidential buffer — so an observer sees that you withdrew, never how much. Any round
            you have won but not claimed is settled first, so withdrawing everything takes your
            winnings with it.
          </p>

          <AmountField
            value={amount}
            onChange={setAmount}
            unit="cUSDC"
            max={me.revealed ? me.balance : undefined}
            maxLabel={me.revealed ? "In the pool" : "In the pool (decrypt to see)"}
            format={(v) => formatUsdc(v)}
            error={problem}
          />

          <button className="primary block" disabled={busy || Boolean(problem) || !amount} onClick={withdraw}>
            Withdraw
          </button>

          <div className="status">
            The buffer&apos;s balance is encrypted to nobody — not even this app can read it — so we
            cannot promise in advance that a withdrawal fills. If it is short you are paid what is
            there and your balance keeps the rest. You will see exactly what landed below, and
            anyone can top the buffer up with <code className="mono">topUpBuffer()</code>.
          </div>

          {me.error && <div className="status status-error">{readableError(me.error)}</div>}
        </div>

        {paid && (
          <div className="card">
            <div className="card-head">
              <h2>{paid.got >= paid.asked ? "Paid in full" : "Partly filled"}</h2>
              <span className="chip chip-mint">only you can see this</span>
            </div>
            <div className="row">
              <span className="row-k">You asked for</span>
              <span className="row-v num">{formatUsdc(paid.asked)} cUSDC</span>
            </div>
            <div className="row">
              <span className="row-k">Actually paid out</span>
              <span className="row-v num">{formatUsdc(paid.got)} cUSDC</span>
            </div>
            <p className="card-hint" style={{ margin: "10px 0 0" }}>
              {paid.got >= paid.asked
                ? "Decrypted from lastWithdrawnOf — a handle the contract granted to your address alone."
                : "The buffer was short. The remainder is still yours, still in the pool; try again after someone calls topUpBuffer()."}
            </p>
          </div>
        )}

        <TxStatus state={state} />
      </Guard>
    </Shell>
  );
}
