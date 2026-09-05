import Link from "next/link";

/**
 * The landing page: one screen, one idea, one button.
 *
 * Static by design — no wagmi, no relayer SDK, no chain reads. It renders when the RPC is down,
 * and nobody is asked for a wallet before they know what this is.
 */
export default function Landing() {
  return (
    <main className="lp">
      <nav className="lp-nav">
        <span className="lp-word">MegaPot</span>
        <Link className="lp-btn" href="/app">
          Launch app
        </Link>
      </nav>

      <section className="lp-mid">
        <h1 className="lp-h1">
          A lottery where
          <br />
          nobody loses.
        </h1>
        <p className="lp-lede">
          Deposit USDC and keep it. Only the yield is played, so your principal is never at risk —
          and your balance, your odds and the winner stay encrypted on-chain.
        </p>
        <Link className="lp-btn lp-btn-lg" href="/app">
          Launch app
        </Link>
      </section>

      <footer className="lp-foot">
        <span>No loss</span>
        <span>Encrypted end to end</span>
        <span>Withdraw anytime</span>
      </footer>
    </main>
  );
}
