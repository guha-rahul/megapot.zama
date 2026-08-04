"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";

import { addresses, confidentialUsdcAbi, erc20Abi, megaPotAbi } from "../lib/contracts";
import { formatUsdc, parseUsdc } from "../lib/format";
import type { usePrivateState, usePublicState } from "../lib/usePool";

const FOREVER = 2 ** 48 - 1;

export function ActionPanel({
  me,
  pool,
}: {
  me: ReturnType<typeof usePrivateState>;
  pool: ReturnType<typeof usePublicState>;
}) {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [amount, setAmount] = useState("100");
  const [status, setStatus] = useState<{ text: string; kind?: "error" | "win" } | null>(null);
  const [busy, setBusy] = useState(false);

  const round = pool.round as { state: number } | undefined;
  const canClaim = round !== undefined && round.state === 4;

  async function run(label: string, fn: () => Promise<`0x${string}`>) {
    if (!walletClient || !publicClient) return;
    setBusy(true);
    setStatus({ text: `${label}…` });
    try {
      const hash = await fn();
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus({ text: `${label} confirmed.` });
      me.refetchHandles();
      pool.refetch();
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  /** Step 0: turn public USDC into confidential cUSDC and let the pool move it. */
  const wrap = () =>
    run("Wrapping USDC", async () => {
      const value = parseUsdc(amount);
      const allowance = await publicClient!.readContract({
        address: addresses.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address!, addresses.confidentialUSDC],
      });
      if (allowance < value) {
        const approveHash = await walletClient!.writeContract({
          address: addresses.usdc,
          abi: erc20Abi,
          functionName: "approve",
          args: [addresses.confidentialUSDC, value],
          chain: null,
          account: address!,
        });
        await publicClient!.waitForTransactionReceipt({ hash: approveHash });
      }
      return walletClient!.writeContract({
        address: addresses.confidentialUSDC,
        abi: confidentialUsdcAbi,
        functionName: "wrap",
        args: [address!, value],
        chain: null,
        account: address!,
      });
    });

  const authorize = () =>
    run("Authorising the pool", () =>
      walletClient!.writeContract({
        address: addresses.confidentialUSDC,
        abi: confidentialUsdcAbi,
        functionName: "setOperator",
        args: [addresses.megaPot, FOREVER],
        chain: null,
        account: address!,
      }),
    );

  /** Encrypt client-side, then submit the ciphertext and its proof. */
  const deposit = () =>
    run("Depositing (encrypted)", async () => {
      const { handle, proof } = await me.encrypt(parseUsdc(amount));
      return walletClient!.writeContract({
        address: addresses.megaPot,
        abi: megaPotAbi,
        functionName: "deposit",
        args: [handle, proof],
        chain: null,
        account: address!,
      });
    });

  const withdraw = () =>
    run("Withdrawing (encrypted)", async () => {
      const { handle, proof } = await me.encrypt(parseUsdc(amount));
      return walletClient!.writeContract({
        address: addresses.megaPot,
        abi: megaPotAbi,
        functionName: "withdraw",
        args: [handle, proof],
        chain: null,
        account: address!,
      });
    });

  const restake = () =>
    run("Re-staking winnings", () =>
      walletClient!.writeContract({
        address: addresses.megaPot,
        abi: megaPotAbi,
        functionName: "restake",
        args: [],
        chain: null,
        account: address!,
      }),
    );

  /**
   * Claiming looks identical whether you won or lost — same call, same gas, same events. The only
   * way to find out is to decrypt your own balance before and after.
   */
  async function claim() {
    if (!walletClient || !publicClient || pool.latestRoundId === undefined) return;
    setBusy(true);
    setStatus({ text: "Claiming…" });
    try {
      const before = me.balance;
      const hash = await walletClient.writeContract({
        address: addresses.megaPot,
        abi: megaPotAbi,
        functionName: "claim",
        args: [pool.latestRoundId],
        chain: null,
        account: address!,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      me.refetchHandles();

      if (before === undefined) {
        setStatus({ text: "Claimed. Decrypt your position to see whether you won." });
      } else {
        await me.reveal();
        setStatus({ text: "Claimed. Decrypt your position again to compare — only you can see the result." });
      }
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || !address || !walletClient;

  return (
    <div className="card">
      <h2>Deposit &amp; play</h2>
      <p className="hint">
        Wrap USDC into confidential cUSDC once, authorise the pool once, then every deposit and
        withdrawal moves an encrypted amount.
      </p>

      <div className="field">
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount in USDC"
          aria-label="Amount in USDC"
        />
        <button className="primary" disabled={disabled || !me.isOperator} onClick={deposit}>
          Deposit
        </button>
      </div>

      <div className="button-row">
        <button disabled={disabled} onClick={wrap}>
          1 · Wrap USDC
        </button>
        <button disabled={disabled || me.isOperator === true} onClick={authorize}>
          {me.isOperator ? "2 · Authorised ✓" : "2 · Authorise pool"}
        </button>
        <button disabled={disabled} onClick={withdraw}>
          Withdraw
        </button>
        <button disabled={disabled} onClick={restake}>
          Re-stake winnings
        </button>
        <button className="primary" disabled={disabled || !canClaim} onClick={claim}>
          {canClaim ? `Claim round #${pool.latestRoundId}` : "No round to claim"}
        </button>
      </div>

      {pool.depositsPaused && <div className="status error">Deposits are paused by governance.</div>}
      {status && <div className={`status ${status.kind ?? ""}`}>{status.text}</div>}

      {me.revealed && me.walletBalance !== undefined && (
        <div className="status">
          Wallet holds {formatUsdc(me.walletBalance)} cUSDC available to deposit.
        </div>
      )}
    </div>
  );
}
