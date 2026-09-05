"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useBalance, useDisconnect, useReadContract } from "wagmi";

import { addresses, confidentialUsdcAbi, erc20Abi, explorerLink } from "../lib/contracts";
import { formatUsdc, shortAddress } from "../lib/format";
import { poolChain } from "../lib/wagmi";

const ZERO_HANDLE = "0x" + "0".repeat(64);

/**
 * The connected account, with what you actually hold.
 *
 * Only the public balances can be shown here — gas and unwrapped USDC. Everything past the wrap is
 * a ciphertext that needs a signature to read, so it is labelled as such rather than left blank or
 * guessed at.
 */
export function AccountMenu() {
  const { address, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data: eth } = useBalance({ address, query: { enabled: Boolean(address), refetchInterval: 15_000 } });

  const { data: usdc } = useReadContract({
    address: addresses.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  });

  const { data: cHandle } = useReadContract({
    address: addresses.confidentialUSDC,
    abi: confidentialUsdcAbi,
    functionName: "confidentialBalanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      const el = document.createElement("textarea");
      el.value = address;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      el.remove();
    }
    setCopied(true);
  }

  if (!address) return null;

  const noGas = eth !== undefined && eth.value === 0n;
  const noUsdc = usdc !== undefined && (usdc as bigint) === 0n;
  const hasWrapped = cHandle !== undefined && cHandle !== ZERO_HANDLE;

  return (
    <div className="wallet-menu" ref={ref}>
      <button className="acct-btn" onClick={() => setOpen((o) => !o)}>
        <span className="mono">{shortAddress(address)}</span>
        {(noGas || noUsdc) && <span className="acct-warn" title="Low balance" />}
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div className="wallet-pop acct-pop" role="menu">
          <div className="acct-head">
            <button className="acct-addr" onClick={copy} title={`Copy ${address}`}>
              <span className="mono">{shortAddress(address, 6)}</span>
              <span className="acct-copy-tag">{copied ? "Copied ✓" : "Copy"}</span>
            </button>
            <div className="acct-via">via {connector?.name ?? "wallet"} · {poolChain.name}</div>
          </div>

          <Row
            label="Sepolia ETH"
            hint="for gas"
            value={eth ? `${Number(eth.formatted).toFixed(4)}` : "—"}
            warn={noGas}
          />
          <Row
            label="Test USDC"
            hint="ready to wrap"
            value={formatUsdc(usdc as bigint | undefined)}
            warn={noUsdc}
            action={
              <a href="https://faucet.circle.com" target="_blank" rel="noreferrer" className="acct-link">
                Faucet ↗
              </a>
            }
          />
          <Row
            label="cUSDC"
            hint="wrapped"
            value={hasWrapped ? <span className="cipher">encrypted</span> : "none yet"}
          />
          <Row label="In the pool" hint="deposited" value={<span className="cipher">encrypted</span>} />

          <div className="acct-note">
            Anything past the wrap is a ciphertext. Decrypt your position in the app to read it —
            only you can.
          </div>

          <div className="acct-actions">
            <a
              href={explorerLink(poolChain.id, address)}
              target="_blank"
              rel="noreferrer"
              className="acct-act"
            >
              Explorer ↗
            </a>
            <button className="acct-act acct-danger" onClick={() => { setOpen(false); disconnect(); }}>
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  hint,
  value,
  warn,
  action,
}: {
  label: string;
  hint: string;
  value: React.ReactNode;
  warn?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="acct-row">
      <div>
        <div className="acct-k">{label}</div>
        <div className="acct-hint">{hint}</div>
      </div>
      <div className="acct-v">
        <span className="num" style={warn ? { color: "var(--danger)" } : undefined}>
          {value}
        </span>
        {action}
      </div>
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
      style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 0.15s" }}
    >
      <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
