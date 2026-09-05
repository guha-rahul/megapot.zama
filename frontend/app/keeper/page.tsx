"use client";

import { useState } from "react";
import { useAccount, useReadContract, useReadContracts } from "wagmi";

import { Countdown, EtaBadge } from "../../components/Guard";
import { Shell } from "../../components/Shell";
import { TxStatus } from "../../components/TxStatus";
import {
  MAIN,
  ROUND_STATES,
  addresses,
  erc20Abi,
  megaPotAbi,
  prizeInboxAbi,
} from "../../lib/contracts";
import { formatUsdc, parseUsdc } from "../../lib/format";
import { ETA } from "../../lib/timing";
import { useJourney } from "../../lib/useJourney";
import { usePrivateState, usePublicState } from "../../lib/usePool";
import { useTx } from "../../lib/useTx";
import { poolChain } from "../../lib/wagmi";
import { publicDecrypt } from "../../lib/zama";

const DAY = 86_400;

/**
 * The operator console.
 *
 * Two of these steps are two-phase: `closeEntries` and `requestSweep` publish a ciphertext for
 * public decryption, and a *separate* call submits the cleartext with its KMS proof. Both phases
 * are wired here so the round lifecycle can be driven without dropping to the CLI.
 */
export default function KeeperPage() {
  const pool = usePublicState();
  const me = usePrivateState();
  const journey = useJourney(me, pool);
  const { address } = useAccount();
  const { run, state, setState, busy } = useTx();
  const [window_, setWindow] = useState("7");
  const [amount, setAmount] = useState("");

  const { data: roles } = useReadContracts({
    contracts: [
      { address: addresses.megaPot, abi: megaPotAbi, functionName: "keeper" },
      { address: addresses.megaPot, abi: megaPotAbi, functionName: "owner" },
    ],
  });
  const keeper = roles?.[0]?.result as string | undefined;
  const owner = roles?.[1]?.result as string | undefined;
  const authorised =
    address !== undefined &&
    [keeper, owner].some((a) => a?.toLowerCase() === address.toLowerCase());

  const { data: pending, refetch: refetchPending } = useReadContract({
    address: addresses.prizeInbox,
    abi: prizeInboxAbi,
    functionName: "pending",
    query: { refetchInterval: 15_000 },
  });

  const { data: usdcBal } = useReadContract({
    address: addresses.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const round = pool.round;
  const id = pool.latestRoundId;
  const after = async () => {
    pool.refetch();
    void refetchPending();
  };

  const write = async (fn: string, args: readonly unknown[]) => {
    const { getWalletClient } = await import("../../lib/clients");
    const wc = await getWalletClient();
    return wc.writeContract({
      address: addresses.megaPot,
      abi: megaPotAbi,
      functionName: fn as never,
      args: args as never,
      chain: poolChain,
      account: address!,
    });
  };

  /** closeEntries publishes the cursor; finalizeEntries submits its KMS-signed cleartext. */
  const closeAndFinalise = async () => {
    if (id === undefined) return;
    const closed = await run("Closing entries", () => write("closeEntries", [MAIN, id]), after);
    if (!closed) return;
    setState({ text: "Asking the KMS to decrypt the ticket total…", busy: true });
    try {
      const { getPublicClient } = await import("../../lib/clients");
      const fresh = (await getPublicClient().readContract({
        address: addresses.megaPot,
        abi: megaPotAbi,
        functionName: "getRound",
        args: [MAIN, id],
      })) as { cursorSnapshot: string };
      const { value, proof } = await publicDecrypt(fresh.cursorSnapshot);
      await run(
        `Publishing ${formatUsdc(value, 0)} tickets`,
        () => write("finalizeEntries", [MAIN, id, value, proof]),
        after,
      );
    } catch (e) {
      setState({ text: (e as Error).message, kind: "error" });
    }
  };

  const sweepAndFinalise = async () => {
    if (id === undefined) return;
    const swept = await run("Requesting sweep", () => write("requestSweep", [MAIN, id]), after);
    if (!swept) return;
    setState({ text: "Asking the KMS whether the prize was claimed…", busy: true });
    try {
      const { getPublicClient } = await import("../../lib/clients");
      const fresh = (await getPublicClient().readContract({
        address: addresses.megaPot,
        abi: megaPotAbi,
        functionName: "getRound",
        args: [MAIN, id],
      })) as { unclaimed: string };
      const { value, proof } = await publicDecrypt(fresh.unclaimed);
      await run(
        value === 0n ? "Round was won — settling" : `Rolling over ${formatUsdc(value)} USDC`,
        () => write("finalizeSweep", [MAIN, id, value, proof]),
        after,
      );
    } catch (e) {
      setState({ text: (e as Error).message, kind: "error" });
    }
  };

  const fund = (fn: "fundPrize" | "fundTicketBudget") =>
    run(
      fn === "fundPrize" ? "Funding the prize" : "Funding the ticket budget",
      async () => {
        const { getPublicClient, getWalletClient } = await import("../../lib/clients");
        const value = parseUsdc(amount || "0");
        if (value === 0n) throw new Error("Enter an amount.");
        const wc = await getWalletClient();
        const pc = getPublicClient();
        const h = await wc.writeContract({
          address: addresses.usdc,
          abi: erc20Abi,
          functionName: "approve",
          args: [addresses.megaPot, value],
          chain: poolChain,
          account: address!,
        });
        await pc.waitForTransactionReceipt({ hash: h });
        // fundPrize is per-track; fundTicketBudget is pool-wide and takes no track.
        return write(fn, fn === "fundPrize" ? [MAIN, value] : [value]);
      },
      async () => {
        setAmount("");
        await after();
      },
    );

  if (!authorised)
    return (
      <Shell pool={pool} journey={journey} showRail={false}>
        <div className="card">
          <div className="guard">
            <div className="guard-icon">🔑</div>
            <h2>Keeper only</h2>
            <p>
              Round operations are restricted to the pool&apos;s keeper or owner. Connect with{" "}
              <span className="mono">{keeper ? `${keeper.slice(0, 10)}…${keeper.slice(-6)}` : "the keeper account"}</span>{" "}
              to use this console.
            </p>
          </div>
        </div>
      </Shell>
    );

  return (
    <Shell pool={pool} journey={journey} showRail={false}>
      <div className="page-head">
        <div className="eyebrow">Operator</div>
        <h1>Keeper console</h1>
        <p>
          Drive the round lifecycle. Two of these are two-phase — a ciphertext is published, the KMS
          signs its cleartext, and a second call submits it on-chain.
        </p>
      </div>

      {/* --- lifecycle -------------------------------------------------- */}
      <div className="card">
        <div className="card-head">
          <h2>Round lifecycle</h2>
          <span className="chip">
            {id !== undefined ? `#${String(id)} · ${round ? ROUND_STATES[round.state] : "—"}` : "no round"}
          </span>
        </div>

        {round && round.state < 4 && (
          <div className="row">
            <span className="row-k">Draw opens</span>
            <span className="row-v">
              <Countdown to={Number(round.drawTime)} done="ready" />
            </span>
          </div>
        )}

        <div className="btn-row" style={{ marginTop: 14 }}>
          <button
            disabled={busy}
            onClick={() =>
              run(
                "Starting a round",
                () => write("startRound", [MAIN, BigInt(Math.floor(Date.now() / 1000) + 300)]),
                after,
              )
            }
          >
            Start round (draws in 5 min)
          </button>
          <button disabled={busy || round?.state !== 1} onClick={closeAndFinalise}>
            Close entries + publish total
          </button>
          <button
            disabled={busy || round?.state !== 3 || !(pool.prizeReserve ?? 0n)}
            title={
              round?.state === 3 && !(pool.prizeReserve ?? 0n)
                ? "The prize reserve is empty — fund it below before drawing."
                : undefined
            }
            onClick={() =>
              run("Drawing", () => write("draw", [MAIN, id!, BigInt(Number(window_) * DAY)]), after)
            }
          >
            Draw
          </button>
          <button disabled={busy || round?.state !== 4} onClick={sweepAndFinalise}>
            Sweep + settle
          </button>
        </div>
        {round?.state === 3 && !(pool.prizeReserve ?? 0n) && (
          <div className="status">
            Entries are settled and this round is ready, but the prize reserve is empty — a draw
            with nothing to award would revert. Fund the prize below first.
          </div>
        )}
        <div className="eta-why">
          Publishing and sweeping each need a KMS round trip — {ETA.publicDecrypt.label}.{" "}
          {ETA.publicDecrypt.because}
        </div>
      </div>

      {/* --- funding ---------------------------------------------------- */}
      <div className="card">
        <div className="card-head">
          <h2>Funding</h2>
          <EtaBadge eta={ETA.tx} />
        </div>
        <p className="card-hint">
          Fund the prize or the Megapot ticket budget straight from your wallet, without waiting
          for a harvest. Both are pull-based and neither ever touches depositor principal — which
          is what keeps arriving prize money from being confused with deposits waiting to be
          invested.
        </p>
        <div className="field">
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.00"
            aria-label="Amount in USDC"
          />
          <span className="field-suffix">USDC</span>
        </div>
        <div className="field-meta">
          <span>
            Your USDC <span className="num">{formatUsdc(usdcBal as bigint | undefined)}</span>
          </span>
        </div>
        <div className="btn-row">
          <button disabled={busy} onClick={() => fund("fundPrize")}>
            Fund prize
          </button>
          <button disabled={busy} onClick={() => fund("fundTicketBudget")}>
            Fund ticket budget
          </button>
        </div>
      </div>

      {/* --- cross-chain ------------------------------------------------ */}
      <div className="card">
        <div className="card-head">
          <h2>Bridge to Megapot</h2>
          <EtaBadge eta={ETA.cctp} />
        </div>
        <div className="row">
          <span className="row-k">Ticket budget</span>
          <span className="row-v num">{formatUsdc(pool.ticketBudget)} USDC</span>
        </div>
        <p className="card-hint" style={{ marginTop: 14 }}>
          Burns the budget to CCTP with the Base agent fixed as recipient. {ETA.cctp.because}. Finish
          on Base with <code className="mono">megapot-base:receive</code>.
        </p>
        <button
          className="block"
          disabled={busy || (pool.ticketBudget ?? 0n) === 0n}
          onClick={() =>
            run("Burning to CCTP", () => write("bridgeToMegapot", [pool.ticketBudget!, 0n]), after)
          }
        >
          Bridge {formatUsdc(pool.ticketBudget)} USDC to Base
        </button>
      </div>

      {/* --- inbox ------------------------------------------------------ */}
      <div className="card">
        <div className="card-head">
          <h2>Prize inbox</h2>
          <EtaBadge eta={ETA.tx} />
        </div>
        <div className="row">
          <span className="row-k">Waiting to be folded into the prize</span>
          <span className="row-v num">{formatUsdc(pending as bigint | undefined)} USDC</span>
        </div>
        <button
          className="block"
          style={{ marginTop: 14 }}
          disabled={busy || ((pending as bigint | undefined) ?? 0n) === 0n}
          onClick={() =>
            run(
              "Flushing the inbox",
              async () => {
                const { getWalletClient } = await import("../../lib/clients");
                const wc = await getWalletClient();
                return wc.writeContract({
                  address: addresses.prizeInbox,
                  abi: prizeInboxAbi,
                  functionName: "flush",
                  args: [],
                  chain: poolChain,
                  account: address!,
                });
              },
              after,
            )
          }
        >
          Flush into prize reserve
        </button>
        <div className="eta-why">
          Permissionless — the inbox has no owner and exactly one exit, into the prize.
        </div>
      </div>

      <TxStatus state={state} />
    </Shell>
  );
}
