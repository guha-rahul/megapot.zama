"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";

import { EtaBadge, Guard } from "../../components/Guard";
import { Allocation } from "../../components/Allocation";
import { Shell } from "../../components/Shell";
import { AmountField, TxStatus } from "../../components/TxStatus";
import { addresses, megaPotAbi } from "../../lib/contracts";
import { formatUsdc, parseUsdc } from "../../lib/format";
import { ETA } from "../../lib/timing";
import { stepNumber, useJourney } from "../../lib/useJourney";
import { usePrivateState, usePublicState } from "../../lib/usePool";
import { useTx } from "../../lib/useTx";
import { poolChain } from "../../lib/wagmi";

/** Deposit an encrypted amount into the pool. */
export default function DepositPage() {
  const pool = usePublicState();
  const me = usePrivateState();
  const journey = useJourney(me, pool);
  const { address } = useAccount();
  const { run, state, setState, busy } = useTx();
  const [amount, setAmount] = useState("");

  const deposit = () =>
    run(
      "Encrypting and depositing",
      async () => {
        const { getWalletClient } = await import("../../lib/clients");
        const value = parseUsdc(amount || "0");
        if (value === 0n) throw new Error("Enter an amount to deposit.");
        setState({ text: "Encrypting in your browser…", busy: true });
        const { handle, proof } = await me.encrypt(value);
        const wc = await getWalletClient();
        return wc.writeContract({
          address: addresses.megaPot,
          abi: megaPotAbi,
          functionName: "deposit",
          args: [handle, proof],
          chain: poolChain,
          account: address!,
        });
      },
      () => {
        setAmount("");
        me.refetchHandles();
        pool.refetch();
      },
    );

  return (
    <Shell pool={pool} journey={journey}>
      <div className="page-head">
        <div className="eyebrow">Step {stepNumber("deposit")}</div>
        <h1>Deposit — encrypted</h1>
        <p>
          Your amount is encrypted in this browser before it is sent, and bound to your address and
          this contract so it cannot be replayed anywhere else.
        </p>
      </div>

      <Guard journey={journey} need="deposit">
        <div className="card">
          <div className="card-head">
            <h2>Amount</h2>
            <EtaBadge eta={ETA.encrypt} />
          </div>
          <p className="card-hint">
            Deposits buy tickets one-for-one, so your odds equal your share of the pool. Your stake
            and your odds are both ciphertexts — <em>nobody</em>, including this app, can read them.
          </p>
          <AmountField
            value={amount}
            onChange={setAmount}
            unit="cUSDC"
            max={me.revealed ? me.walletBalance : undefined}
            maxLabel={me.revealed ? "Wrapped" : "Wrapped (decrypt to see)"}
            format={(v) => formatUsdc(v)}
          />
          <button
            className="primary block"
            disabled={busy || pool.depositsPaused}
            onClick={deposit}
          >
            Deposit encrypted
          </button>
          <div className="eta-why">{ETA.encrypt.because}</div>
          {pool.depositsPaused && (
            <div className="status status-error">Deposits are paused by governance.</div>
          )}
        </div>

        <TxStatus state={state} />

        {journey.hasDeposited && <Allocation me={me} />}

        {journey.hasDeposited && (
          <div className="status">
            <span>
              You have a position.{" "}
              <Link href="/position" style={{ color: "var(--gold)", fontWeight: 600 }}>
                View it →
              </Link>{" "}
              Deposits made after a round&apos;s entries close count toward the next round.
            </span>
          </div>
        )}
      </Guard>
    </Shell>
  );
}
