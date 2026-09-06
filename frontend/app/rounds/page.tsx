"use client";

import { useReadContracts } from "wagmi";

import { Shell } from "../../components/Shell";
import { MAIN, MEGA, ROUND_STATES, addresses, explorerLink, megaPotAbi } from "../../lib/contracts";
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

  return (
    <Shell pool={pool} journey={journey} showRail={false}>
      <div className="page-head">
        <div className="eyebrow">The draw</div>
        <h1>Draws</h1>
        <p>
          Every draw the pool has run. Prizes and ticket totals are public; who won each one is not,
          and never becomes so.
        </p>
      </div>

      <DrawStatus pool={pool} now={now} />

      <TrackTable
        track={MAIN}
        count={Number(pool.roundsLength ?? 0n)}
        title="Main prize"
        blurb="Funded by the pool's yield. Every depositor plays it, with odds proportional to stake."
        now={now}
      />

      <TrackTable
        track={MEGA}
        count={Number(pool.megaRoundsLength ?? 0n)}
        title="Megapot prize"
        blurb="Funded by winnings returning from the real Megapot jackpot on Base. Opt-in — you play it only for the share of your stake you allocate."
        now={now}
      />

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

/**
 * Why you cannot run the draw yourself.
 *
 * The nav sends people here under the word "Draw", so the page owes them an answer about the
 * current round rather than only a table of past ones. Nobody arriving should have to infer from
 * an absence of buttons that the draw is keeper-gated — and the reason it is gated is worth
 * saying, because it is the opposite of the usual one: the keeper cannot influence the outcome,
 * only its timing.
 */
function DrawStatus({ pool, now }: { pool: ReturnType<typeof usePublicState>; now: number }) {
  const round = pool.round;
  if (!round) return null;

  const drawsIn = Number(round.drawTime) - now;
  const state = ROUND_STATES[round.state] ?? "unknown";

  const explanation =
    round.state === 1
      ? drawsIn > 0
        ? `Entries are open. The draw becomes possible in ${humanDuration(drawsIn)}, once the round's draw time passes — it is fixed on-chain and cannot be brought forward.`
        : "The draw time has passed. The keeper closes entries next, which reveals the ticket total and nothing else."
      : round.state === 2
        ? "Entries are closed and the ticket total is being revealed through Zama's KMS. That takes a moment and anyone can complete it."
        : round.state === 3
          ? drawsIn > 0
            ? `Ready to draw in ${humanDuration(drawsIn)}.`
            : "Ready to draw now. Waiting on the keeper."
          : round.state === 4
            ? "Drawn. The winning ticket is encrypted and readable by nobody — claim to find out whether it was yours."
            : "This round is settled.";

  return (
    <div className="card">
      <div className="card-head">
        <h2>Round #{String(pool.latestRoundId)}</h2>
        <span className="chip">{state}</span>
      </div>
      <p className="card-hint" style={{ margin: "4px 0 0" }}>{explanation}</p>
      <div className="status">
        {/* `.status` is a flex row, so its children must be a single element or the sentence
            breaks into columns. */}
        <span>
          Running a draw is restricted to the pool&apos;s keeper, but that buys them no advantage:
          the winning ticket comes from <code className="mono">FHE.randEuint64()</code> and is
          granted no decryption rights at all, so the keeper cannot read it, predict it, or pick
          who wins. What they control is <em>when</em> a round is drawn, not <em>how</em>.
        </span>
      </div>
    </div>
  );
}

/**
 * One track's history.
 *
 * The two tracks are independent games with their own rounds, reserves and ticket totals, so they
 * get their own tables rather than one merged list — a round number means nothing without the
 * track it belongs to.
 */
function TrackTable({
  track,
  count,
  title,
  blurb,
  now,
}: {
  track: number;
  count: number;
  title: string;
  blurb: string;
  now: number;
}) {
  const { data } = useReadContracts({
    contracts: Array.from({ length: count }, (_, i) => ({
      address: addresses.megaPot,
      abi: megaPotAbi,
      functionName: "getRound" as const,
      args: [track, BigInt(i)] as const,
    })),
    query: { enabled: count > 0, refetchInterval: 20_000 },
  });

  const rounds = (data ?? []).map((r, i) => ({ id: i, ...(r.result as unknown as RoundView) }));

  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
        <span className="chip">{count === 0 ? "no rounds" : `${count} round${count === 1 ? "" : "s"}`}</span>
      </div>
      <p className="card-hint">{blurb}</p>
      {count === 0 ? (
        <p className="card-hint" style={{ margin: 0 }}>No rounds have been run on this track yet.</p>
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
                  {/* A round's prize is assigned at draw time, from whatever the reserve holds
                      then. Before that it is genuinely undecided, not zero. */}
                  <td>{r.state >= 4 ? formatUsdc(r.prize) : "at draw"}</td>
                  {/* A round that has not closed has no revealed total yet — 0 would read as
                      "nobody entered". */}
                  <td>{r.totalTickets ? formatUsdc(r.totalTickets, 0) : "sealed"}</td>
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
  );
}
