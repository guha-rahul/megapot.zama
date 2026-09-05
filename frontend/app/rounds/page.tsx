"use client";

import { useReadContracts } from "wagmi";

import { Shell } from "../../components/Shell";
import { MAIN, ROUND_STATES, addresses, explorerLink, megaPotAbi } from "../../lib/contracts";
import { formatUsdc } from "../../lib/format";
import { humanDuration } from "../../lib/timing";
import { useJourney } from "../../lib/useJourney";
import { useNow, usePrivateState, usePublicState, type RoundView } from "../../lib/usePool";
import { poolChain } from "../../lib/wagmi";

/** Every round the pool has ever run — prize, size, state, and whether it found an owner. */
export default function RoundsPage() {
  const pool = usePublicState();
  const me = usePrivateState();
  const journey = useJourney(me, pool);
  const now = useNow();

  const n = Number(pool.roundsLength ?? 0n);
  const { data } = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({
      address: addresses.megaPot,
      abi: megaPotAbi,
      functionName: "getRound" as const,
      args: [MAIN, BigInt(i)] as const,
    })),
    query: { enabled: n > 0, refetchInterval: 20_000 },
  });

  const rounds = (data ?? []).map((r, i) => ({ id: i, ...(r.result as unknown as RoundView) }));

  return (
    <Shell pool={pool} journey={journey} showRail={false}>
      <div className="page-head">
        <div className="eyebrow">Transparency</div>
        <h1>Round history</h1>
        <p>
          Every draw the pool has run. Prizes and ticket totals are public; who won each one is not,
          and never becomes so.
        </p>
      </div>

      <div className="card">
        {n === 0 ? (
          <p className="card-hint" style={{ margin: 0 }}>No rounds have been run yet.</p>
        ) : (
          <table className="rtable">
            <thead>
              <tr>
                <th>Round</th>
                <th>Prize</th>
                <th>Tickets</th>
                <th>State</th>
                <th>Drawn / due</th>
              </tr>
            </thead>
            <tbody>
              {rounds.map((r) => {
                const drawn = r.state >= 4;
                const windowOpen = r.state === 4 && Number(r.claimDeadline) > now;
                return (
                  <tr key={r.id}>
                    <td>
                      <a
                        href={explorerLink(poolChain.id, addresses.megaPot)}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: "var(--text)" }}
                      >
                        #{r.id}
                      </a>
                    </td>
                    <td>{formatUsdc(r.prize)}</td>
                    <td>{formatUsdc(r.totalTickets, 0)}</td>
                    <td>
                      <span className={`chip ${windowOpen ? "chip-gold" : ""}`}>
                        {windowOpen && <span className="dot dot-pulse" />}
                        {windowOpen ? "claimable" : ROUND_STATES[r.state].toLowerCase()}
                      </span>
                    </td>
                    <td>
                      {drawn
                        ? windowOpen
                          ? `closes in ${humanDuration(Number(r.claimDeadline) - now)}`
                          : "settled"
                        : `in ${humanDuration(Number(r.drawTime) - now)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Reading this table</h2>
        </div>
        <p className="card-hint" style={{ margin: 0 }}>
          A round sits in <strong>claimable</strong> until its window closes, then waits for a sweep
          to reach <strong>settled</strong>. A round that stays claimable long after its deadline
          simply has not been swept — the prize is not lost. If a draw lands on a ticket released by
          a withdrawal, nobody claims it and the prize rolls into the next round.
        </p>
      </div>
    </Shell>
  );
}
