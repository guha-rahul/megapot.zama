"use client";

import { useState } from "react";
import { useAccount, useDisconnect, usePublicClient, useWalletClient } from "wagmi";

import { addresses, confidentialUsdcAbi, erc20Abi, explorerLink, megaPotAbi } from "../lib/contracts";
import { formatCountdown, formatOdds, formatUsdc, parseUsdc, readableError } from "../lib/format";
import { useChainSwitch } from "../lib/useChainSwitch";
import { useHasClaimed, useNow, type PrivateState, type PublicState } from "../lib/usePool";
import { poolChain } from "../lib/wagmi";

const FOREVER = 2 ** 48 - 1;

type Status = { text: string; kind?: "error" | "win"; busy?: boolean; hash?: string } | null;

/**
 * The whole app, as one sequence.
 *
 * There is exactly one thing to do at any moment, and it is the only step expanded. Everything
 * already done collapses to a tick; everything ahead stays dim. The user never has to work out
 * what to click next, and never meets an error telling them to go and do something else first.
 */
export function Journey({ me, pool }: { me: PrivateState; pool: PublicState }) {
  const { address, isConnected, chainId, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const { data: walletClient } = useWalletClient();
  const chainSwitch = useChainSwitch();
  const publicClient = usePublicClient();
  const now = useNow();

  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  const { hasClaimed, refetch: refetchClaimed } = useHasClaimed(pool.latestRoundId, address);

  // Ticket ranges are public, so we can tell whether someone has deposited without decrypting.
  const hasDeposited = me.rangeCount > 0;
  const round = pool.round;
  const canClaim = round?.state === 4 && hasClaimed === false;
  const wrongChain = isConnected && chainId !== poolChain.id;

  const step: number = !isConnected
    ? 1
    : wrongChain
      ? 1
      : !me.hasWrapped && (me.usdcBalance ?? 0n) === 0n
        ? 2
        : !me.hasWrapped
          ? 3
          : !me.isOperator
            ? 4
            : !hasDeposited
              ? 5
              : canClaim
                ? 7
                : 6;

  async function run(label: string, fn: () => Promise<`0x${string}`>, after?: () => void) {
    if (!walletClient || !publicClient) return;
    setBusy(true);
    setStatus({ text: label, busy: true });
    try {
      const hash = await fn();
      setStatus({ text: `${label} — confirming…`, busy: true, hash });
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus({ text: `${label} — done.`, hash });
      me.refetchHandles();
      pool.refetch();
      after?.();
    } catch (e) {
      setStatus({ text: readableError(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  const wrap = () =>
    run("Wrapping USDC", async () => {
      const value = parseUsdc(amount || "0");
      if (value === 0n) throw new Error("Enter an amount first.");
      const allowance = await publicClient!.readContract({
        address: addresses.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address!, addresses.confidentialUSDC],
      });
      if (allowance < value) {
        const h = await walletClient!.writeContract({
          address: addresses.usdc,
          abi: erc20Abi,
          functionName: "approve",
          args: [addresses.confidentialUSDC, value],
          chain: poolChain,
          account: address!,
        });
        await publicClient!.waitForTransactionReceipt({ hash: h });
      }
      return walletClient!.writeContract({
        address: addresses.confidentialUSDC,
        abi: confidentialUsdcAbi,
        functionName: "wrap",
        args: [address!, value],
        chain: poolChain,
        account: address!,
      });
    }, () => setAmount(""));

  const allow = () =>
    run("Allowing the pool", () =>
      walletClient!.writeContract({
        address: addresses.confidentialUSDC,
        abi: confidentialUsdcAbi,
        functionName: "setOperator",
        args: [addresses.megaPot, FOREVER],
        chain: poolChain,
        account: address!,
      }),
    );

  const deposit = () =>
    run("Encrypting and depositing", async () => {
      const value = parseUsdc(amount || "0");
      if (value === 0n) throw new Error("Enter an amount first.");
      const { handle, proof } = await me.encrypt(value);
      return walletClient!.writeContract({
        address: addresses.megaPot,
        abi: megaPotAbi,
        functionName: "deposit",
        args: [handle, proof],
        chain: poolChain,
        account: address!,
      });
    }, () => setAmount(""));

  const withdraw = () =>
    run("Encrypting and withdrawing", async () => {
      const value = parseUsdc(amount || "0");
      if (value === 0n) throw new Error("Enter an amount first.");
      const { handle, proof } = await me.encrypt(value);
      return walletClient!.writeContract({
        address: addresses.megaPot,
        abi: megaPotAbi,
        functionName: "withdraw",
        args: [handle, proof],
        chain: poolChain,
        account: address!,
      });
    }, () => setAmount(""));

  const claim = () =>
    run(`Claiming round #${pool.latestRoundId}`, () =>
      walletClient!.writeContract({
        address: addresses.megaPot,
        abi: megaPotAbi,
        functionName: "claim",
        args: [pool.latestRoundId!],
        chain: poolChain,
        account: address!,
      }),
      () => {
        void refetchClaimed();
        void me.reveal();
      },
    );

  const Amount = ({ max, unit }: { max?: bigint; unit: string }) => (
    <>
      <div className="field">
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="0.00"
          aria-label="Amount"
        />
        <span className="field-suffix">{unit}</span>
      </div>
      {max !== undefined && max > 0n && (
        <div className="field-meta">
          <span>
            Available <span className="num">{formatUsdc(max)}</span>
          </span>
          <button className="link-btn" onClick={() => setAmount(formatUsdc(max).replace(/,/g, ""))}>
            Max
          </button>
        </div>
      )}
    </>
  );

  return (
    <div className="journey">
      <Step n={1} step={step} label="Connect your wallet" done={isConnected && !wrongChain}>
        <p className="jstep-why">
          The pool lives on {poolChain.name}, where the Zama Protocol runs.
        </p>
        {wrongChain ? (
          <>
            <button className="primary cta" disabled={chainSwitch.busy} onClick={() => void chainSwitch.go()}>
              {chainSwitch.busy ? "Switching…" : `Switch to ${poolChain.name}`}
            </button>
            <p className="jstep-why" style={{ margin: "10px 0 0" }}>
              Connected with <strong>{connector?.name ?? "your wallet"}</strong>. It should ask for chain{" "}
              <span className="mono">{poolChain.id}</span> ({poolChain.name}).
            </p>
            {chainSwitch.error && <div className="status status-error">{chainSwitch.error}</div>}
            <div className="status">
              <span>
                Solana-first wallets like Phantom often will not switch to an Ethereum testnet.{" "}
                <button className="link-btn" onClick={() => disconnect()}>
                  Disconnect and choose another wallet
                </button>{" "}
                — MetaMask or Rabby both work.
              </span>
            </div>
          </>
        ) : (
          <p className="jstep-why">Use the Connect button at the top right.</p>
        )}
      </Step>

      <Step n={2} step={step} label="Get some test USDC" done={step > 2} skipped={me.hasWrapped}>
        <p className="jstep-why">
          Your wallet has no Sepolia USDC. Grab some free from Circle&apos;s faucet, then come back —
          this is testnet money, worth nothing.
        </p>
        <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
          <button className="primary cta">Open Circle faucet ↗</button>
        </a>
      </Step>

      <Step
        n={3}
        step={step}
        label="Wrap USDC into cUSDC"
        done={step > 3}
        aside={me.hasWrapped ? "done" : undefined}
      >
        <p className="jstep-why">
          cUSDC is the confidential version of USDC. Wrapping is public and one-off — do it in a
          round number, because everything you do <em>after</em> this is encrypted.
        </p>
        <Amount max={me.usdcBalance} unit="USDC" />
        <button className="primary cta" disabled={busy} onClick={wrap}>
          Wrap
        </button>
      </Step>

      <Step n={4} step={step} label="Allow the pool to move it" done={step > 4}>
        <p className="jstep-why">
          One approval so the pool can pull your encrypted deposits. It cannot see the amounts.
        </p>
        <button className="primary cta" disabled={busy} onClick={allow}>
          Allow
        </button>
      </Step>

      <Step n={5} step={step} label="Deposit — encrypted" done={hasDeposited}>
        <p className="jstep-why">
          Your amount is encrypted in this browser before it is sent. Nobody — not an explorer, not
          another depositor, not this app — can read it.
        </p>
        <Amount max={me.revealed ? me.walletBalance : undefined} unit="cUSDC" />
        <button className="primary cta" disabled={busy || pool.depositsPaused} onClick={deposit}>
          Deposit
        </button>
        {pool.depositsPaused && <div className="status status-error">Deposits are paused.</div>}
      </Step>

      <Step
        n={6}
        step={step}
        label={canClaim ? "You were in the draw" : "You're in the draw"}
        done={step > 6}
        aside={
          round && round.state < 4 ? `draws in ${formatCountdown(Number(round.drawTime), now)}` : undefined
        }
      >
        <div className="pos">
          <div className="pos-item">
            <div className="pos-k">Your balance</div>
            <div className="pos-v num">
              {me.revealed ? formatUsdc(me.balance) : <span className="cipher">••••••</span>}
            </div>
          </div>
          <div className="pos-item">
            <div className="pos-k">Win chance</div>
            <div className="pos-v num" style={{ color: me.revealed ? "var(--gold)" : undefined }}>
              {me.revealed ? formatOdds(me.tickets, pool.settledTickets) : <span className="cipher">••••</span>}
            </div>
          </div>
          <div className="pos-item">
            <div className="pos-k">Prize</div>
            <div className="pos-v num">{formatUsdc(round?.state === 4 ? round.prize : pool.prizeReserve)}</div>
          </div>
        </div>
        <div className="btn-row" style={{ marginTop: 14 }}>
          <button className="mint" style={{ flex: 1 }} disabled={me.busy} onClick={() => void me.reveal()}>
            {me.busy ? "Decrypting…" : me.revealed ? "Refresh" : "Decrypt my position"}
          </button>
          <button disabled={busy} onClick={() => setAmount("")}>
            Deposit more
          </button>
        </div>
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--text-faint)" }}>
            Withdraw instead
          </summary>
          <div style={{ marginTop: 10 }}>
            <Amount max={me.revealed ? me.balance : undefined} unit="cUSDC" />
            <button className="cta" disabled={busy} onClick={withdraw}>
              Withdraw — full principal, any time
            </button>
          </div>
        </details>
      </Step>

      <Step n={7} step={step} label={hasClaimed ? "Claimed" : "Claim your result"} done={hasClaimed === true}>
        <p className="jstep-why">
          Winning and losing are the <em>same</em> transaction — same call, same gas, same events.
          The only way to learn which one you made is to decrypt your own balance afterwards.
        </p>
        <button className="primary cta" disabled={busy || !canClaim} onClick={claim}>
          {canClaim ? `Claim round #${pool.latestRoundId}` : "Nothing to claim yet"}
        </button>
      </Step>

      {status && (
        <div
          className={`status ${status.kind === "error" ? "status-error" : status.kind === "win" ? "status-win" : ""}`}
        >
          {status.busy && <span className="spinner" />}
          <span>
            {status.text}
            {status.hash && (
              <>
                {" "}
                <a
                  href={explorerLink(poolChain.id, status.hash, "tx")}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--text)", borderBottom: "1px solid var(--line-strong)" }}
                >
                  View ↗
                </a>
              </>
            )}
          </span>
        </div>
      )}
      {me.error && <div className="status status-error">{readableError(me.error)}</div>}
    </div>
  );
}

function Step({
  n,
  step,
  label,
  done,
  skipped,
  aside,
  children,
}: {
  n: number;
  step: number;
  label: string;
  done?: boolean;
  skipped?: boolean;
  aside?: string;
  children: React.ReactNode;
}) {
  if (skipped && n !== step) return null;
  const state = done ? "done" : n === step ? "active" : "todo";
  return (
    <div className="jstep" data-state={state}>
      <div className="jstep-head">
        <span className="jstep-num">{state === "done" ? "✓" : n}</span>
        <span className="jstep-label">{label}</span>
        {aside && <span className="jstep-aside">{aside}</span>}
      </div>
      {state === "active" && <div className="jstep-body">{children}</div>}
    </div>
  );
}
