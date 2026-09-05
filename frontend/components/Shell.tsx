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
          {pool.unreachable && <Unreachable detail={pool.unreachable} />}
          <PrizeBar pool={pool} />
          {showRail && journey && <StepRail journey={journey} />}
          {children}
        </div>
        <Footer />
      </main>
    </>
  );
}

/**
 * Say that the chain is unreachable, rather than rendering every figure as an em dash and letting
 * the user decide whether the app is broken or the pool is simply empty.
 */
function Unreachable({ detail }: { detail: string }) {
  return (
    <div className="status status-error">
      <span>
        <strong style={{ color: "var(--text)" }}>Cannot reach Sepolia right now.</strong> Public RPC
        endpoints rate-limit, and this app polls. Everything below is stale or blank for that
        reason, not because the pool is empty — your funds are unaffected either way. It retries on
        its own; a page refresh usually picks a healthier node.
        <span className="mono" style={{ display: "block", marginTop: 6, opacity: 0.7 }}>
          {detail.split("\n")[0].slice(0, 160)}
        </span>
      </span>
    </div>
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
          {/* The total is the revealed cursor, which only exists once entries close. Printing 0
              before that reads as "nobody has deposited", which is a different claim entirely. */}
          <div className={pool.settledTickets ? "stat-v num" : "stat-v"}>
            {pool.settledTickets ? formatUsdc(pool.settledTickets, 0) : "sealed"}
          </div>
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
        <Link href="/setup">Setup</Link>
        <Link href="/bridge">Megapot</Link>
        <Link href="/privacy">What&apos;s encrypted</Link>
        <Link href="/keeper">Keeper console</Link>
      </div>
    </footer>
  );
}
