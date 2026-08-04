"use client";

import { ROUND_STATES } from "../lib/contracts";
import { formatCountdown, formatUsdc } from "../lib/format";
import type { usePublicState } from "../lib/usePool";

export function PoolHero({ pool }: { pool: ReturnType<typeof usePublicState> }) {
  const round = pool.round as
    | { drawTime: bigint; totalTickets: bigint; prize: bigint; state: number }
    | undefined;

  const isDrawn = round !== undefined && round.state >= 4;
  const prize = isDrawn ? round!.prize : pool.prizeReserve;

  return (
    <section className="hero">
      <div className="label">{isDrawn ? "This round's prize" : "Prize building"}</div>
      <div className="prize">{formatUsdc(prize)} USDC</div>
      <div className="sub">
        Funded entirely by the yield on pooled deposits. Nobody&apos;s principal is ever at stake.
      </div>

      <dl className="hero-meta">
        <div>
          <dt>Round</dt>
          <dd>
            {pool.latestRoundId === undefined ? "—" : `#${pool.latestRoundId}`}{" "}
            <span className={`pill ${round && round.state === 4 ? "live" : ""}`}>
              {round ? ROUND_STATES[round.state] : "none yet"}
            </span>
          </dd>
        </div>
        <div>
          <dt>Draws in</dt>
          <dd>{round && round.state < 4 ? formatCountdown(Number(round.drawTime)) : "—"}</dd>
        </div>
        <div>
          <dt>Tickets in play</dt>
          <dd>{formatUsdc(pool.settledTickets, 0)}</dd>
        </div>
        <div>
          <dt>Pooled principal</dt>
          <dd>{formatUsdc(pool.deployedPrincipal, 0)} USDC</dd>
        </div>
        <div>
          <dt>Winner</dt>
          <dd>
            <span className="cipher">encrypted</span>
          </dd>
        </div>
      </dl>
    </section>
  );
}
