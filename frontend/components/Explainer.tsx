"use client";

/** How the money moves, and what each chain is for. */
export function FlowMap() {
  return (
    <div className="card">
      <div className="card-head">
        <h2>How it works</h2>
        <span className="chip">2 chains, 1 pool</span>
      </div>
      <p className="card-hint">
        The Zama Protocol is not deployed on Base and Megapot exists only on Base — so the
        confidential ledger and the lottery position live on different chains, joined by Circle
        CCTP with the destination fixed at burn time.
      </p>

      <div className="flow">
        <div className="flow-node">
          <div className="flow-chain">Ethereum Sepolia</div>
          <div className="flow-title">You deposit</div>
          <div className="flow-body">
            An encrypted amount of cUSDC. Your balance and odds become ciphertexts only you can
            read.
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-node">
          <div className="flow-chain">Ethereum Sepolia</div>
          <div className="flow-title">Principal earns yield</div>
          <div className="flow-body">
            Pooled principal goes to an ERC-4626 venue. Only the <em>surplus</em> above principal is
            ever spent.
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-node">
          <div className="flow-chain">Base Sepolia</div>
          <div className="flow-title">Yield buys tickets</div>
          <div className="flow-body">
            The agent plays that yield in the real Megapot jackpot and holds the position in its own
            name.
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-node">
          <div className="flow-chain">Ethereum Sepolia</div>
          <div className="flow-title">One depositor wins</div>
          <div className="flow-body">
            Winnings return and a confidential draw awards them — odds proportional to stake, winner
            encrypted.
          </div>
        </div>
      </div>
    </div>
  );
}

/** The claim the product actually makes, itemised — including what it does not hide. */
export function PrivacyTable() {
  const rows: [string, string, "you" | "nobody" | "public"][] = [
    ["Your deposit amount", "euint64 ciphertext", "you"],
    ["Your pool balance", "euint64 ciphertext", "you"],
    ["Your odds (ticket range)", "two euint64 ciphertexts", "you"],
    ["The winning ticket", "euint64 ciphertext", "nobody"],
    ["Who won, and how much", "select(hit, prize, 0)", "you"],
    ["Your withdrawal amount", "euint64 ciphertext", "you"],
    ["Pooled totals, prize size", "plaintext", "public"],
  ];

  return (
    <div className="card">
      <div className="card-head">
        <h2>What&apos;s encrypted</h2>
        <span className="chip chip-mint">
          <span className="dot" /> Zama FHEVM
        </span>
      </div>
      <p className="card-hint">
        Pool-wide aggregates are public by necessity — the money sits in a real yield venue and a
        real lottery, where its size is visible anyway. Every <em>per-user</em> quantity is not.
      </p>
      <table className="ptable">
        <thead>
          <tr>
            <th>Quantity</th>
            <th>On-chain</th>
            <th>Readable by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([what, form, who]) => (
            <tr key={what}>
              <td>{what}</td>
              <td className="mono" style={{ fontSize: 11.5 }}>
                {form}
              </td>
              <td>
                {who === "public" ? (
                  <span className="chip">everyone</span>
                ) : who === "nobody" ? (
                  <span className="chip chip-gold">nobody</span>
                ) : (
                  <span className="chip chip-mint">only you</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="status">
        <span>
          Two things do leak, and both are bounded: closing a round reveals the pool&apos;s{" "}
          <em>aggregate</em> stake, and sweeping reveals <em>whether</em> a prize was claimed —
          never by whom.
        </span>
      </div>
    </div>
  );
}
