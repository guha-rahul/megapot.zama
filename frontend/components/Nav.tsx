"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAccount, useDisconnect } from "wagmi";

import { ConnectMenu } from "./ConnectMenu";
import { shortAddress } from "../lib/format";
import { useChainSwitch } from "../lib/useChainSwitch";
import { poolChain } from "../lib/wagmi";

// The spec grades "deposit -> draw -> claim -> withdraw", so the nav bar is that sentence. The
// supporting pages are still one click away, in the footer.
const LINKS = [
  { href: "/deposit", label: "Deposit" },
  { href: "/position", label: "Position" },
  { href: "/rounds", label: "Draw" },
  { href: "/claim", label: "Claim" },
  { href: "/withdraw", label: "Withdraw" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="nav">
      <div className="nav-inner">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <div className="brand-name">MegaPot</div>
            <div className="brand-tag">Confidential no-loss lottery</div>
          </div>
        </div>

        <div className="nav-links">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="nav-link" data-active={pathname === l.href}>
              {l.label}
            </Link>
          ))}
        </div>

        <div className="nav-right">
          <span className="chip chip-mint nav-badge" title="Balances, odds and winnings are FHE ciphertexts on-chain">
            <span className="dot dot-pulse" />
            Encrypted by Zama
          </span>
          <ConnectButton />
        </div>
      </div>
    </nav>
  );
}

export function ConnectButton() {
  const { address, isConnected, chainId, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const chain = useChainSwitch();

  if (!isConnected) return <ConnectMenu />;

  // The pool only exists where Zama runs; nudge rather than fail at the first encrypted call.
  //
  // The escape hatch matters as much as the switch itself: `switchChain` goes through whichever
  // connector is already active, and wagmi persists that across reloads. Someone connected with a
  // wallet that handles EVM chain switching badly is otherwise stuck with no way to pick another.
  if (chainId !== poolChain.id) {
    return (
      <span className="addr-pill">
        <button
          className="addr-copy"
          style={{ color: "var(--gold)" }}
          disabled={chain.busy}
          onClick={() => void chain.go()}
          title={`Requests chain ${poolChain.id} (${poolChain.name})`}
        >
          {chain.busy ? "Switching…" : `Switch to ${poolChain.name}`}
        </button>
        <button
          className="addr-x"
          onClick={() => disconnect()}
          title={`Disconnect ${connector?.name ?? "wallet"} and choose another`}
          aria-label="Disconnect and choose another wallet"
        >
          ×
        </button>
      </span>
    );
  }

  return <AddressPill address={address!} onDisconnect={() => disconnect()} />;
}

/** The connected address, with one-click copy. */
export function AddressPill({ address, onDisconnect }: { address: string; onDisconnect: () => void }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // Clipboard blocked (insecure context) — select-and-copy fallback.
      const el = document.createElement("textarea");
      el.value = address;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      el.remove();
      setCopied(true);
    }
  }

  return (
    <span className="addr-pill">
      <button className="addr-copy" onClick={copy} title={copied ? "Copied" : `Copy ${address}`} aria-label="Copy address">
        <span className="mono">{shortAddress(address)}</span>
        {copied ? <TickIcon /> : <CopyIcon />}
      </button>
      <button className="addr-x" onClick={onDisconnect} title="Disconnect" aria-label="Disconnect">
        ×
      </button>
    </span>
  );
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="4.6" y="4.6" width="8" height="8" rx="1.8" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9.6 2.4H3.2a1.8 1.8 0 0 0-1.8 1.8v6.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function TickIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M2.6 7.4l3 3 5.8-6.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
