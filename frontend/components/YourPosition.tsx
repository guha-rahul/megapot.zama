"use client";

import { formatOdds, formatUsdc } from "../lib/format";
import type { usePrivateState, usePublicState } from "../lib/usePool";

/**
 * Everything here lives on-chain as a ciphertext. The numbers appear only after the user signs a
 * decryption request, and the plaintext never leaves their browser.
 */
export function YourPosition({
  me,
  pool,
}: {
  me: ReturnType<typeof usePrivateState>;
  pool: ReturnType<typeof usePublicState>;
}) {
  const hidden = <span className="cipher">•••••• encrypted</span>;

  return (
    <div className="card">
      <h2>Your position</h2>
      <p className="hint">
        Your balance, your odds and your winnings are FHE ciphertexts on-chain — no indexer, block
        explorer, or other depositor can read them. Sign once to decrypt them locally.
      </p>

      <div className="row">
        <span className="k">
          Pool balance <span className="lock">FHE</span>
        </span>
        <span className="v">{me.revealed ? `${formatUsdc(me.balance)} USDC` : hidden}</span>
      </div>
      <div className="row">
        <span className="k">
          Your tickets <span className="lock">FHE</span>
        </span>
        <span className="v">{me.revealed ? formatUsdc(me.tickets, 0) : hidden}</span>
      </div>
      <div className="row">
        <span className="k">Win chance</span>
        <span className="v">{me.revealed ? formatOdds(me.tickets, pool.settledTickets) : hidden}</span>
      </div>
      <div className="row">
        <span className="k">
          Wallet cUSDC <span className="lock">FHE</span>
        </span>
        <span className="v">{me.revealed ? `${formatUsdc(me.walletBalance)} cUSDC` : hidden}</span>
      </div>

      <div className="button-row">
        <button className="primary" disabled={!me.address || me.busy} onClick={() => void me.reveal()}>
          {me.busy ? "Decrypting…" : me.revealed ? "Refresh" : "Decrypt my position"}
        </button>
        {me.revealed && <button onClick={me.clear}>Hide</button>}
      </div>

      {me.error && <div className="status error">{me.error}</div>}
    </div>
  );
}
