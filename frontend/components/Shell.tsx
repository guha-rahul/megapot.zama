"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ROUND_STATES } from "../lib/contracts";
import { formatUsdc } from "../lib/format";
import { humanDuration } from "../lib/timing";
import { STEPS, type Journey } from "../lib/useJourney";
import { useNow, type PublicState } from "../lib/usePool";
import { Nav } from "./Nav";

/**
 * The frame every page shares: nav, a live prize bar, and the step rail.
 *
 * Splitting a linear flow across routes is only safe if the user can always see where they are —
 * the rail is what stops a deep link from feeling like being dropped somewhere random.
 */
export function Shell({
  pool,
  journey,
  showRail = true,
  children,
}: {
  pool: PublicState;
  journey?: Journey;
  showRail?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <Nav />
      <main className="shell" style={{ maxWidth: 820 }}>
        <div className="stack">
          <PrizeBar pool={pool} />
          {showRail && journey && <StepRail journey={journey} />}
          {children}
        </div>
        <Footer />
      </main>
    </>
  );
}

function PrizeBar({ pool }: { pool: PublicState }) {
  const now = useNow();
  const round = pool.round;
  const claimOpen = round?.state === 4 && Number(round.claimDeadline) > now;
  const prize = claimOpen ? round!.prize : pool.prizeReserve;

  return (
    <Link href="/app" className="prizebar">
      <div>
        <div className="stat-k">{claimOpen ? "This round's prize" : "Next prize building"}</div>
        <div className="prizebar-v num">{formatUsdc(prize)} USDC</div>
      </div>
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <div className="stat-k">Tickets</div>
          <div className="stat-v num">{formatUsdc(pool.settledTickets, 0)}</div>
        </div>
        <div>
          <div className="stat-k">{round && round.state < 4 ? "Draws in" : "Round"}</div>
          <div className="stat-v num">
            {round && round.state < 4
              ? humanDuration(Number(round.drawTime) - now)
              : pool.latestRoundId !== undefined
                ? `#${String(pool.latestRoundId)}`
                : "—"}
          </div>
        </div>
        <span className={`chip ${claimOpen ? "chip-gold" : ""}`}>
          {claimOpen && <span className="dot dot-pulse" />}
          {round ? ROUND_STATES[round.state] : "no round"}
        </span>
      </div>
    </Link>
  );
}

function StepRail({ journey }: { journey: Journey }) {
  const pathname = usePathname();
  return (
    <nav className="rail" aria-label="Progress">
      {STEPS.map((s, i) => {
        const state = journey.done[s.key] ? "done" : s.key === journey.current ? "current" : "todo";
        const active = pathname === s.href;
        return (
          <div key={s.key} style={{ display: "contents" }}>
            {i > 0 && <span className="rail-sep">›</span>}
            <Link
              href={s.href}
              className="rail-step"
              data-state={active ? "current" : state}
              aria-current={active ? "page" : undefined}
            >
              <span className="rail-num">{state === "done" ? "✓" : i + 1}</span>
              {s.label}
            </Link>
          </div>
        );
      })}
    </nav>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div style={{ maxWidth: "50ch" }}>
        Prizes come from yield only — principal is never spent on a draw. Unaudited software on
        public testnets; do not use with real funds.
      </div>
      <div className="addr-list">
        <Link href="/rounds">Round history</Link>
        <Link href="/bridge">Cross-chain</Link>
        <Link href="/privacy">What&apos;s encrypted</Link>
        <Link href="/keeper">Keeper console</Link>
      </div>
    </footer>
  );
}
