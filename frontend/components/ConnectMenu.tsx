"use client";

import { useEffect, useRef, useState } from "react";
import { useConnect } from "wagmi";

/**
 * A wallet picker.
 *
 * Grabbing `connectors[0]` is wrong the moment someone has more than one wallet installed: EIP-6963
 * announcement order is arbitrary, so the app silently binds to whichever spoke first — commonly a
 * Solana-first wallet like Phantom, which then handles EVM chain switching poorly. Whose wallet it
 * is, is the user's call.
 */
export function ConnectMenu() {
  const { connect, connectors, isPending, error } = useConnect();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // De-duplicate: some wallets announce over EIP-6963 *and* inject window.ethereum.
  const seen = new Set<string>();
  const wallets = connectors.filter((c) => {
    const key = (c.name || c.id).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (wallets.length === 0) {
    return (
      <span className="chip" title="Install an Ethereum wallet such as MetaMask or Rabby">
        No wallet detected
      </span>
    );
  }

  // Only one wallet — no point making anyone choose.
  if (wallets.length === 1) {
    return (
      <button className="primary" disabled={isPending} onClick={() => connect({ connector: wallets[0] })}>
        {isPending ? "Connecting…" : `Connect ${wallets[0].name}`}
      </button>
    );
  }

  return (
    <div className="wallet-menu" ref={ref}>
      <button className="primary" disabled={isPending} onClick={() => setOpen((o) => !o)}>
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
      {open && (
        <div className="wallet-pop" role="menu">
          <div className="wallet-pop-head">Choose a wallet</div>
          {wallets.map((c) => (
            <button
              key={c.uid}
              className="wallet-opt"
              onClick={() => {
                setOpen(false);
                connect({ connector: c });
              }}
            >
              {c.icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.icon} alt="" width={18} height={18} />
              ) : (
                <span className="wallet-fallback">{c.name.slice(0, 1)}</span>
              )}
              <span>{c.name}</span>
            </button>
          ))}
          <div className="wallet-pop-note">
            This app is Ethereum-only. A Solana-first wallet may handle network switching poorly —
            prefer MetaMask or Rabby.
          </div>
        </div>
      )}
      {error && <div className="status status-error">{error.message}</div>}
    </div>
  );
}
