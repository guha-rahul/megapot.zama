"use client";

import Link from "next/link";

import { Shell } from "../../components/Shell";
import { ROUND_STATES, isConfigured } from "../../lib/contracts";
import { formatUsdc } from "../../lib/format";
import { humanDuration } from "../../lib/timing";
import { useJourney } from "../../lib/useJourney";
import { useNow, usePrivateState, usePublicState } from "../../lib/usePool";

/** The app home: what the prize is, and one button pointing at your actual next step. */
export default function Home() {
  const pool = usePublicState();
  const me = usePrivateState();
  const journey = useJourney(me, pool);
  const now = useNow();

  const next = {
    connect: { href: "/setup", label: "Get started" },
    setup: { href: "/setup", label: "Finish setup" },
    deposit: { href: "/deposit", label: "Make your first deposit" },
    position: { href: "/position", label: "View your position" },
    claim: { href: "/claim", label: "Claim your result" },
  }[journey.current];

  const round = pool.round;
  const claimOpen = round?.state === 4 && Number(round.claimDeadline) > now;

  if (!isConfigured())
    return (
      <Shell pool={pool} showRail={false}>
        <div className="card">
          <h2>Point the app at a deployment</h2>
          <p className="card-hint">
            Copy <code className="mono">.env.local.example</code> to{" "}
            <code className="mono">.env.local</code>, then rebuild.
          </p>
        </div>
      </Shell>
    );

  return (
    <Shell pool={pool} journey={journey}>
      <section className="hero">
        <div className="hero-head">
          <div>
            <div className="eyebrow">{claimOpen ? "This round's prize" : "Next prize building"}</div>
            <h1 className="hero-prize num">
              {formatUsdc(claimOpen ? round!.prize : pool.prizeReserve)}
              <small>USDC</small>
            </h1>
          </div>
        </div>
        <p className="hero-sub">
          Deposit, win the yield, lose nothing. One depositor takes the whole prize, chosen with
          probability proportional to their stake —{" "}
          <strong style={{ color: "var(--text)", fontWeight: 600 }}>and nobody can see who.</strong>
        </p>
        <div style={{ marginTop: 20, position: "relative" }}>
          <Link href={next.href}>
            <button className="primary" style={{ padding: "12px 22px", fontSize: 14.5 }}>
              {next.label} →
            </button>
          </Link>
        </div>
        <div className="hero-stats">
          <div>
            <div className="stat-k">Tickets in play</div>
            <div className="stat-v num">{formatUsdc(pool.settledTickets, 0)}</div>
          </div>
          <div>
            <div className="stat-k">Round</div>
            <div className="stat-v num">
              {pool.latestRoundId !== undefined ? `#${String(pool.latestRoundId)}` : "—"}
            </div>
          </div>
          <div>
            <div className="stat-k">{round && round.state < 4 ? "Draws in" : "State"}</div>
            <div className="stat-v num">
              {round && round.state < 4
                ? humanDuration(Number(round.drawTime) - now)
                : round
                  ? ROUND_STATES[round.state]
                  : "—"}
            </div>
          </div>
          <div>
            <div className="stat-k">Winner</div>
            <div className="stat-v">
              <span className="cipher">encrypted</span>
            </div>
          </div>
        </div>
      </section>

      <div className="grid-3">
        {[
          ["No loss", "Prizes come from yield only. Your principal is never spent on a draw."],
          ["Encrypted", "Your balance, odds and winnings are FHE ciphertexts only you can read."],
          ["Verifiable", "Every figure here is read live from chain. Follow any address and check."],
        ].map(([t, d]) => (
          <div className="card" key={t}>
            <h2>{t}</h2>
            <p className="card-hint" style={{ margin: "6px 0 0" }}>
              {d}
            </p>
          </div>
        ))}
      </div>
    </Shell>
  );
}
