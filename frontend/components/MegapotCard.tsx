"use client";

import { BASE_SEPOLIA_ID, addresses, explorerLink, hasMegapotLeg } from "../lib/contracts";
import { formatCountdown, formatUsdc, shortAddress } from "../lib/format";
import { humanDuration } from "../lib/timing";
import type { MegapotLeg, PublicState } from "../lib/usePool";
import { useNow } from "../lib/usePool";

/**
 * The Base half. Everything here is deliberately public — it is pool-aggregate activity in a real
 * lottery, at a granularity MegaPot already publishes. Which depositor ends up with the money is
 * still decided on the other chain, under encryption.
 */
export function MegapotCard({ leg, pool }: { leg: MegapotLeg; pool: PublicState }) {
  const now = useNow();
  if (!hasMegapotLeg()) return null;

  // What harvest would actually route right now, computed by the contract rather than guessed
  // here — so the card cannot disagree with the pool about its own state.
  const shareBps = Number(pool.megapotShareBps ?? 0);
  const enabled = shareBps > 0;
  const roundEnds = leg.roundEndsAt !== undefined ? Number(leg.roundEndsAt) : undefined;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Megapot leg — Base Sepolia</h2>
        <span className={`chip ${enabled ? "chip-gold" : ""}`}>
          {enabled ? `${(shareBps / 100).toFixed(1)}% of yield` : "Nothing allocated yet"}
        </span>
      </div>
      <p className="card-hint">
        Harvested yield crosses to Base over Circle CCTP and buys tickets in the{" "}
        <a href={explorerLink(BASE_SEPOLIA_ID, addresses.jackpot)} target="_blank" rel="noreferrer">
          live Megapot jackpot
        </a>
        . Winnings come back and become the prize the confidential draw awards.
      </p>

      <div className="row">
        <span className="row-k">Pool&apos;s share of the round</span>
        <span className="row-v num">
          {leg.share !== undefined ? `${(leg.share * 100).toFixed(2)}%` : "—"}
          <span style={{ color: "var(--text-faint)", fontWeight: 500 }}>
            {leg.heldBps !== undefined ? ` · ${leg.heldBps.toLocaleString()} bps` : ""}
          </span>
        </span>
      </div>
      <div className="row">
        <span className="row-k">Staked / won on Megapot</span>
        <span className="row-v num">
          {formatUsdc(leg.totalSpent, 0)} / {formatUsdc(leg.totalWon, 0)}
        </span>
      </div>
      <div className="row">
        <span className="row-k">Jackpot pot size</span>
        <span className="row-v num">{formatUsdc(leg.userPoolTotal, 0)}</span>
      </div>
      <div className="row">
        <span className="row-k">Megapot round settles</span>
        {/* `formatCountdown` collapses everything already past into "now", which is right for a
            draw about to happen and wrong for this: Base Sepolia's jackpot round ended months ago
            and never rolled, so "now" claimed an imminent settlement that will never arrive.
            A dormant round should read as dormant. */}
        <span className="row-v num">
          {roundEnds === undefined || roundEnds === 0
            ? "—"
            : roundEnds > now
              ? formatCountdown(roundEnds, now)
              : `ended ${humanDuration(now - roundEnds)} ago`}
        </span>
      </div>
      <div className="row">
        <span className="row-k" title="Megapot's cut of every ticket purchased">
          House edge
        </span>
        <span className="row-v num">
          {leg.feeBps !== undefined ? `${Number(leg.feeBps) / 100}%` : "—"}
        </span>
      </div>

      <div className="status">
        {enabled ? (
          <span>
            Playing yield on an external lottery buys variance at a cost: at a{" "}
            {leg.feeBps !== undefined ? `${Number(leg.feeBps) / 100}%` : ""} edge, each unit staked
            returns less than one in expectation. Principal is never staked — only yield.
          </span>
        ) : (
          <span>
            No depositor has allocated any yield to Megapot yet, so all of it funds the main prize.
            This is not a switch anyone flips centrally — the share is whatever the pool&apos;s
            depositors chose, weighted by stake, and it reads zero until someone opts in and both
            tracks have had their ticket totals revealed.
          </span>
        )}
      </div>

      <div className="field-meta" style={{ marginTop: 12, marginBottom: 0 }}>
        <span>
          Agent{" "}
          <a
            className="mono"
            href={explorerLink(BASE_SEPOLIA_ID, addresses.ticketAgent)}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--text-dim)" }}
          >
            {shortAddress(addresses.ticketAgent)}
          </a>
        </span>
        <span>Base Sepolia</span>
      </div>
    </div>
  );
}
