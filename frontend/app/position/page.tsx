"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";

import { EtaBadge, Guard } from "../../components/Guard";
import { Shell } from "../../components/Shell";
import { AmountField, TxStatus } from "../../components/TxStatus";
import { addresses, megaPotAbi } from "../../lib/contracts";
import { formatOdds, formatUsdc, parseUsdc, readableError } from "../../lib/format";
import { ETA } from "../../lib/timing";
import { useJourney } from "../../lib/useJourney";
import { usePrivateState, usePublicState } from "../../lib/usePool";
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
            <span className="row-v num">{me.revealed ? formatUsdc(me.tickets, 0) : hidden}</span>
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

        {journey.claimable && (
          <div className="status status-win">
            <span>
              Round #{String(pool.latestRoundId)} is drawn and you were in it.{" "}
              <Link href="/claim" style={{ color: "var(--gold)", fontWeight: 700 }}>
                Claim your result →
              </Link>
            </span>
          </div>
        )}

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
