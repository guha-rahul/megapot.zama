import Link from "next/link";

/**
 * The landing page.
 *
 * Static by design — no wagmi, no relayer SDK, no chain reads. It renders when the RPC is down,
 * and nobody is asked for a wallet before they know what this is. Every visual below is inline
 * SVG or plain markup for the same reason: nothing here can fail to load.
 *
 * The diagrams are load-bearing rather than decorative. "Confidential no-loss lottery" is four
 * words that each sound like marketing; the ticket-space picture is the one thing that makes the
 * mechanism legible at a glance, and the mechanism is what people are being asked to trust.
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
        <div className="lp-cta">
          <Link className="lp-btn lp-btn-lg" href="/app">
            Launch app
          </Link>
          <Link className="lp-link" href="/faucet">
            Get test assets first →
          </Link>
        </div>
        <a className="lp-scroll" href="#how">
          <span>How it works</span>
          <svg width="13" height="19" viewBox="0 0 14 20" fill="none" aria-hidden="true">
            <path d="M7 0v17M1 11l6 6 6-6" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </a>
      </section>

      <section className="lps" id="how">
        <div className="lps-in">
          <span className="lps-tag">The ticket space</span>
          <h2 className="lps-h2">Odds proportional to stake, with the stakes hidden.</h2>
          <p className="lps-p">
            The pool keeps one running cursor over a space of tickets. A deposit claims the next
            slice of it, so your odds are exactly your share — and because the cursor is a
            ciphertext, your slice never moves a number anybody can read.
          </p>
          <TicketSpace />
        </div>
      </section>

      <section className="lps lps-alt">
        <div className="lps-in">
          <span className="lps-tag">Confidentiality</span>
          <h2 className="lps-h2">What an observer actually sees.</h2>
          <p className="lps-p">
            On a transparent chain a prize-savings pool publishes every depositor&apos;s balance,
            every wallet&apos;s odds, and the winner of every draw. Here the same reads come back
            as ciphertext handles.
          </p>

          <div className="lps-cmp">
            <div className="lps-col">
              <div className="lps-col-h">
                <span className="lps-dot lps-dot-red" />
                On a transparent chain
              </div>
              {[
                ["balanceOf(0xa1…)", "9,000.00 USDC"],
                ["balanceOf(0xb2…)", "1,000.00 USDC"],
                ["oddsOf(0xa1…)", "90.00%"],
                ["winnerOf(round 7)", "0xa1…"],
              ].map(([k, v]) => (
                <div className="lps-row" key={k}>
                  <span className="lps-k mono">{k}</span>
                  <span className="lps-v mono">{v}</span>
                </div>
              ))}
            </div>

            <div className="lps-col">
              <div className="lps-col-h">
                <span className="lps-dot lps-dot-mint" />
                On MegaPot
              </div>
              {[
                ["confidentialBalanceOf(0xa1…)", "0x43a7b143…a70500"],
                ["confidentialBalanceOf(0xb2…)", "0x9c2f0ea8…a70500"],
                ["rangesOf(0xa1…)", "0x1f77bd40…a70500"],
                ["round.ticket", "0xfb5769b9…a70500"],
              ].map(([k, v]) => (
                <div className="lps-row" key={k}>
                  <span className="lps-k mono">{k}</span>
                  <span className="lps-v mono lps-cipher">{v}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="lps-note">
            Every value on the right is an <code className="mono">euint64</code> handle. Balances
            and ranges decrypt for their owner and nobody else. The winning ticket decrypts for{" "}
            <strong>nobody at all</strong> — not the keeper, not the deployer.
          </p>
        </div>
      </section>

      <section className="lps">
        <div className="lps-in">
          <span className="lps-tag">The loop</span>
          <h2 className="lps-h2">Only the yield is ever at stake.</h2>
          <p className="lps-p">
            Principal goes to work in a yield venue and stays yours. The surplus above it — and
            only the surplus — becomes the prize one depositor wins.
          </p>
          <Loop />
        </div>
      </section>

      <section className="lps lps-alt">
        <div className="lps-in">
          <span className="lps-tag">Two chains</span>
          <h2 className="lps-h2">The confidential ledger and the real jackpot.</h2>
          <p className="lps-p">
            Zama&apos;s FHE coprocessor does not exist on Base; Megapot exists nowhere else. So the
            encrypted ledger lives on Ethereum, the lottery position lives on Base, and
            Circle&apos;s CCTP joins them — with the destination fixed at burn time, so a keeper
            can delay the flow but never redirect it.
          </p>
          <TwoChains />
        </div>
      </section>

      <section className="lps lps-end">
        <div className="lps-in">
          <h2 className="lps-h2">Try the whole cycle on Sepolia.</h2>
          <p className="lps-p">
            Deposit, watch a draw, decrypt what you won, withdraw in full. The test assets are
            free, and the principal comes back whatever happens.
          </p>
          <div className="lp-cta">
            <Link className="lp-btn lp-btn-lg" href="/app">
              Launch app
            </Link>
            <Link className="lp-link" href="/faucet">
              Get test assets →
            </Link>
          </div>
        </div>
      </section>

      <footer className="lp-foot">
        <span>No loss</span>
        <span>Encrypted end to end</span>
        <span>Withdraw anytime</span>
      </footer>
    </main>
  );
}

/**
 * The ticket space, drawn honestly.
 *
 * The endpoints are public — the revealed cursor total is the draw's modulus and has to be. The
 * boundaries *between* depositors are not, which is the whole trick, so they are drawn as dashed
 * seams rather than solid rules. The hatched slice is dead space left by a withdrawal: the cursor
 * never rewinds, so a draw landing there finds no owner and the prize rolls over.
 */
function TicketSpace() {
  const segs = [
    { x: 0, w: 250, label: "a depositor", fill: "var(--gold-soft)" },
    { x: 250, w: 330, label: "another", fill: "rgba(27,77,245,0.16)" },
    { x: 580, w: 150, label: "released", fill: "url(#dead)", dead: true },
    { x: 730, w: 230, label: "another still", fill: "var(--gold-soft)" },
  ];
  return (
    <figure className="lps-fig">
      <svg
        viewBox="0 0 960 186"
        className="lps-svg"
        role="img"
        aria-label="A bar of lottery tickets divided into depositor ranges with encrypted boundaries, one released dead slice, and an encrypted winning-ticket marker."
      >
        <defs>
          <pattern id="dead" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="7" stroke="var(--line-strong)" strokeWidth="1.5" />
          </pattern>
        </defs>

        <text x="0" y="24" className="lps-svg-dim">0</text>
        <text x="960" y="24" textAnchor="end" className="lps-svg-dim">
          total tickets — public
        </text>

        {segs.map((s) => (
          <g key={s.x}>
            <rect x={s.x} y={38} width={s.w} height={54} fill={s.fill} stroke="var(--gold-line)" />
            <text
              x={s.x + s.w / 2}
              y={114}
              textAnchor="middle"
              className={s.dead ? "lps-svg-faint" : "lps-svg-dim"}
            >
              {s.label}
            </text>
          </g>
        ))}

        {[250, 580, 730].map((x) => (
          <line
            key={x}
            x1={x}
            y1={30}
            x2={x}
            y2={100}
            stroke="var(--mint)"
            strokeWidth="1.5"
            strokeDasharray="3 3"
          />
        ))}
        <text x={580} y={138} textAnchor="middle" className="lps-svg-mint">
          every boundary is encrypted
        </text>

        <line x1={392} y1={20} x2={392} y2={92} stroke="var(--text)" strokeWidth="1.5" strokeDasharray="4 3" />
        <circle cx={392} cy={65} r="6" fill="var(--bg)" stroke="var(--text)" strokeWidth="1.5" />
        <text x={392} y={168} textAnchor="middle" className="lps-svg-dim">
          the drawn ticket — a ciphertext nobody can read
        </text>
      </svg>
      <figcaption className="lps-cap">
        Withdrawing shrinks your range from the top. The tickets it releases stay inside the space
        but belong to nobody — so a draw can land on empty ground, and the prize rolls into the
        next round. That is the price of keeping stake sizes private, and it behaves like a
        rollover jackpot.
      </figcaption>
    </figure>
  );
}

/** Deposit → invest → harvest → draw → claim, with principal never leaving the lane below. */
function Loop() {
  const steps: [string, string][] = [
    ["Deposit", "encrypted amount in"],
    ["Invest", "principal to a vault"],
    ["Harvest", "surplus only"],
    ["Draw", "FHE randomness"],
    ["Claim", "winner decrypts"],
  ];
  return (
    <figure className="lps-fig">
      <div className="lps-steps">
        {steps.map(([t, s], i) => (
          <div className="lps-step" key={t}>
            <span className="lps-step-n mono">{i + 1}</span>
            <span className="lps-step-t">{t}</span>
            <span className="lps-step-s">{s}</span>
          </div>
        ))}
      </div>
      <div className="lps-lane">
        <span className="lps-lane-l">Your principal</span>
        <span className="lps-lane-bar" />
        <span className="lps-lane-r">withdrawable in full, at any point above</span>
      </div>
      <figcaption className="lps-cap">
        <code className="mono">harvest()</code> can only ever move what a venue earned <em>above</em>{" "}
        deployed principal, and it is permissionless. There is no code path that spends principal on
        a prize.
      </figcaption>
    </figure>
  );
}

/** Ethereum holds the confidential ledger; Base holds the jackpot position; CCTP is the seam. */
function TwoChains() {
  return (
    <figure className="lps-fig">
      <div className="lps-chains">
        <div className="lps-chain">
          <div className="lps-chain-h">Ethereum</div>
          <div className="lps-chain-s">Zama Protocol · FHE</div>
          <ul className="lps-chain-l">
            <li>Encrypted per-user ledger</li>
            <li>Encrypted ticket space</li>
            <li>The draw and the winner</li>
          </ul>
        </div>

        <div className="lps-seam" aria-hidden="true">
          <svg viewBox="0 0 120 58" className="lps-seam-svg">
            <line x1="4" y1="18" x2="104" y2="18" stroke="var(--gold)" strokeWidth="1.4" />
            <path d="M104 18l-8-4v8z" fill="var(--gold)" />
            <line x1="116" y1="40" x2="16" y2="40" stroke="var(--gold)" strokeWidth="1.4" />
            <path d="M16 40l8-4v8z" fill="var(--gold)" />
          </svg>
          <span className="lps-seam-t mono">CCTP</span>
        </div>

        <div className="lps-chain">
          <div className="lps-chain-h">Base</div>
          <div className="lps-chain-s">Megapot · the real jackpot</div>
          <ul className="lps-chain-l">
            <li>Buys tickets as a contract</li>
            <li>Claims winnings</li>
            <li>Sends proceeds home</li>
          </ul>
        </div>
      </div>
      <figcaption className="lps-cap">
        Nothing per-user crosses. Everything on Base is pool-aggregate — spend, tickets held,
        winnings — which MegaPot publishes in the clear anyway. Which depositor ends up with the
        money is decided on the Ethereum side, under encryption.
      </figcaption>
    </figure>
  );
}
