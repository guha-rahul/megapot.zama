"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";

import { EtaBadge, Guard } from "../../components/Guard";
import { Shell } from "../../components/Shell";
import { AmountField, TxStatus } from "../../components/TxStatus";
import { addresses, confidentialUsdcAbi, erc20Abi } from "../../lib/contracts";
import { formatUsdc, parseUsdc } from "../../lib/format";
import { ETA } from "../../lib/timing";
import { stepNumber, useJourney } from "../../lib/useJourney";
import { usePrivateState, usePublicState } from "../../lib/usePool";
import { useTx } from "../../lib/useTx";
import { poolChain } from "../../lib/wagmi";

const FOREVER = 2 ** 48 - 1;

/** One-time onboarding: hold test USDC, wrap it, let the pool move it. */
export default function SetupPage() {
  const pool = usePublicState();
  const me = usePrivateState();
  const journey = useJourney(me, pool);
  const { address } = useAccount();
  const { run, state, busy } = useTx();
  const [amount, setAmount] = useState("");
  const publicClientReady = Boolean(address);
  const alreadyAuthorised = me.isOperator === true;

  // `wrapAndAuthorize` does the wrap and the operator grant in one call. It has to live on the
  // token rather than in a helper: `setOperator` keys off `msg.sender`, so a contract calling it
  // would authorise an operator for itself, not for the caller.
  const wrap = () =>
    run(
      alreadyAuthorised ? "Wrapping USDC into cUSDC" : "Wrapping and authorising",
      async () => {
        const { getPublicClient, getWalletClient } = await import("../../lib/clients");
        const pc = getPublicClient();
        const wc = await getWalletClient();
        const value = parseUsdc(amount || "0");
        if (value === 0n) throw new Error("Enter an amount to wrap.");
        const allowance = await pc.readContract({
          address: addresses.usdc,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address!, addresses.confidentialUSDC],
        });
        if (allowance < value) {
          const h = await wc.writeContract({
            address: addresses.usdc,
            abi: erc20Abi,
            functionName: "approve",
            args: [addresses.confidentialUSDC, value],
            chain: poolChain,
            account: address!,
          });
          await pc.waitForTransactionReceipt({ hash: h });
        }
        return alreadyAuthorised
          ? wc.writeContract({
              address: addresses.confidentialUSDC,
              abi: confidentialUsdcAbi,
              functionName: "wrap",
              args: [address!, value],
              chain: poolChain,
              account: address!,
            })
          : wc.writeContract({
              address: addresses.confidentialUSDC,
              abi: confidentialUsdcAbi,
              functionName: "wrapAndAuthorize",
              args: [address!, value, addresses.megaPot, FOREVER],
              chain: poolChain,
              account: address!,
            });
      },
      () => {
        setAmount("");
        me.refetchHandles();
      },
    );

  const authorise = () =>
    run(
      "Authorising the pool",
      async () => {
        const { getWalletClient } = await import("../../lib/clients");
        const wc = await getWalletClient();
        return wc.writeContract({
          address: addresses.confidentialUSDC,
          abi: confidentialUsdcAbi,
          functionName: "setOperator",
          args: [addresses.megaPot, FOREVER],
          chain: poolChain,
          account: address!,
        });
      },
      () => me.refetchHandles(),
    );

  return (
    <Shell pool={pool} journey={journey}>
      <div className="page-head">
        <div className="eyebrow">Step {stepNumber("setup")}</div>
        <h1>Set up your confidential balance</h1>
        <p>
          Get the test token, then wrap it once. After this, every deposit and withdrawal you make
          moves an amount nobody else can read.
        </p>
      </div>

      <Guard journey={journey} need="connect">
        {/* --- get USDC ------------------------------------------------ */}
        <div className="card">
          <div className="card-head">
            <h2>1 · Hold some test USDC</h2>
            {(me.usdcBalance ?? 0n) > 0n || me.hasWrapped ? (
              <span className="chip chip-mint">done</span>
            ) : (
              <span className="chip">needed</span>
            )}
          </div>
          <p className="card-hint">
            Sepolia USDC is free and worth nothing. You also need a little Sepolia ETH for gas.
          </p>
          <div className="row">
            <span className="row-k">Your USDC</span>
            <span className="row-v num">{formatUsdc(me.usdcBalance)}</span>
          </div>
          {(me.usdcBalance ?? 0n) === 0n && !me.hasWrapped && (
            <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
              <button className="primary block" style={{ marginTop: 14 }}>
                Open Circle faucet ↗
              </button>
            </a>
          )}
        </div>

        {/* --- wrap ----------------------------------------------------- */}
        <div className="card">
          <div className="card-head">
            <h2>2 · Wrap USDC into cUSDC</h2>
            {me.hasWrapped ? <span className="chip chip-mint">done</span> : <EtaBadge eta={ETA.tx} />}
          </div>
          <p className="card-hint">
            cUSDC is the confidential (ERC-7984) version of USDC. Wrapping itself is public, so do it
            in a round number — everything you do <em>after</em> this is encrypted.
          </p>
          <AmountField
            value={amount}
            onChange={setAmount}
            unit="USDC"
            max={me.usdcBalance}
            format={(v) => formatUsdc(v)}
          />
          <button
            className="primary block"
            disabled={busy || !publicClientReady || (me.usdcBalance ?? 0n) === 0n}
            onClick={wrap}
          >
            {me.hasWrapped ? "Wrap more" : "Wrap"}
          </button>
        </div>

        {/* --- authorise ------------------------------------------------ */}
        <div className="card">
          <div className="card-head">
            <h2>3 · Let the pool move it</h2>
            {me.isOperator ? <span className="chip chip-mint">done</span> : <EtaBadge eta={ETA.tx} />}
          </div>
          <p className="card-hint">
            The pool needs permission to pull your encrypted deposits. It never sees the amounts —
            only ciphertext handles it is permitted to compute on.{" "}
            {me.isOperator
              ? "Granted."
              : "Wrapping above grants this in the same transaction, so you should not need this button."}
          </p>
          <button
            className="primary block"
            disabled={busy || me.isOperator === true || !me.hasWrapped}
            onClick={authorise}
          >
            {me.isOperator ? "Authorised ✓" : "Authorise the pool"}
          </button>
          {!me.hasWrapped && !me.isOperator && (
            <div className="status">
              Nothing to do yet — wrap above and this is granted along with it. The button is a
              fallback for a balance wrapped before the pool existed.
            </div>
          )}
        </div>

        <TxStatus state={state} />

        {journey.setupDone && (
          <div className="status status-win">
            <span>
              Setup complete.{" "}
              <Link href="/deposit" style={{ color: "var(--gold)", fontWeight: 600 }}>
                Make your first deposit →
              </Link>
            </span>
          </div>
        )}
      </Guard>
    </Shell>
  );
}
