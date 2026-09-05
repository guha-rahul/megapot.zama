"use client";

import { formatCountdown, formatUsdc } from "../lib/format";
import { useNow, type PublicState } from "../lib/usePool";

/**
 * The headline. The prize is the only number allowed to be big.
 *
 * It shows the *pool's* state, never the viewer's — so it must never imply the viewer has
 * something to claim. A drawn round whose claim window has closed is history, not an offer: the
 * live number in that case is what is building for the next draw.
 */
export function Hero({ pool }: { pool: PublicState }) {
  const now = useNow();
  const round = pool.round;

  const drawn = round !== undefined && round.state >= 4;
  const claimWindowOpen = round?.state === 4 && Number(round.claimDeadline) > now;
  const building = !claimWindowOpen;

  // While a claim window is open the live prize is that round's; otherwise it is the reserve
  // accumulating toward the next draw.
  const prize = claimWindowOpen ? round!.prize : pool.prizeReserve;

  return (
    <section className="hero">
      <div className="hero-head">
        <div>
          <div className="eyebrow">{claimWindowOpen ? "This round's prize" : "Next prize building"}</div>
          <h1 className="hero-prize num">
            {pool.isLoading ? <span className="skel" style={{ width: 200, height: 52 }} /> : formatUsdc(prize)}
            <small>USDC</small>
          </h1>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
          {claimWindowOpen ? (
            <span className="chip chip-gold">
              <span className="dot dot-pulse" />
              Claim window open
            </span>
          ) : round && drawn ? (
            <span className="chip">Round #{String(pool.latestRoundId)} settled</span>
          ) : round ? (
            <span className="chip">Round #{String(pool.latestRoundId)} — {roundPhase(round.state)}</span>
          ) : (
            <span className="chip">No round yet</span>
          )}
        </div>
      </div>

      <p className="hero-sub">
        Funded by yield on pooled deposits — no depositor&apos;s principal is ever at stake. One
        depositor takes the whole prize, chosen with probability proportional to their stake.{" "}
        <strong style={{ color: "var(--text)", fontWeight: 600 }}>Nobody can see who.</strong>
      </p>

      <div className="hero-stats">
        <div>
          <div className="stat-k">Tickets in play</div>
          <div className="stat-v num">{formatUsdc(pool.settledTickets, 0)}</div>
        </div>
        <div>
          <div className="stat-k">{round && round.state < 4 ? "Draws in" : "Last draw"}</div>
          <div className="stat-v num">
            {round && round.state < 4
              ? formatCountdown(Number(round.drawTime), now)
              : drawn
                ? `#${String(pool.latestRoundId)}`
                : "—"}
          </div>
        </div>
        <div>
          <div className="stat-k">Rounds run</div>
          <div className="stat-v num">{String(pool.roundsLength ?? 0n)}</div>
        </div>
        <div>
          <div className="stat-k">Winner</div>
          <div className="stat-v">
            <span className="cipher">encrypted</span>
          </div>
        </div>
      </div>

      {building && drawn && (
        <div className="status" style={{ marginTop: 16 }}>
          <span>
            Round #{String(pool.latestRoundId)} was drawn and its claim window has closed — that
            prize already went to one depositor, privately. This number is what is accumulating for
            the next draw.
          </span>
        </div>
      )}
    </section>
  );
}

function roundPhase(state: number) {
  return ["not started", "entries open", "closing entries", "ready to draw", "claimable", "sweeping", "settled"][
    state
  ];
}
