"use client";

import Link from "next/link";

import { MegapotCard } from "../../components/MegapotCard";
import { Shell } from "../../components/Shell";
import { Pipeline } from "../../components/Pipeline";
import { BASE_SEPOLIA_ID, addresses, explorerLink, isConfigured } from "../../lib/contracts";
import { formatUsdc, shortAddress } from "../../lib/format";
import { useJourney } from "../../lib/useJourney";
import { useMegapotLeg, usePrivateState, usePublicState } from "../../lib/usePool";
import { poolChain } from "../../lib/wagmi";

export default function BridgePage() {
  const pool = usePublicState();
  const me = usePrivateState();
  const leg = useMegapotLeg();
  const journey = useJourney(me, pool);

  return (
    <Shell pool={pool} journey={journey} showRail={false}>
      <>
        {!isConfigured() ? (
          <div className="card">Configure `.env.local` first.</div>
        ) : (
          <div className="stack">
            <section className="hero">
              <div className="hero-head">
                <div>
                  <div className="eyebrow">Cross-chain</div>
                  <h1 className="hero-prize num" style={{ fontSize: "clamp(34px, 5.5vw, 50px)" }}>
                    {formatUsdc(leg.totalSpent, 0)}
                    <small>USDC staked on Megapot</small>
                  </h1>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className="chip">Ethereum Sepolia</span>
                  <span className="chip">→</span>
                  <span className="chip chip-gold">Base Sepolia</span>
                </div>
              </div>
              <p className="hero-sub">
                The Zama Protocol runs on Ethereum; Megapot exists only on Base. So the confidential
                ledger and the lottery position live on different chains, joined by Circle CCTP —
                with the destination fixed at burn time, which makes the keeper a liveness
                dependency rather than a custodian.
              </p>
              <div className="hero-stats">
                <div>
                  <div className="stat-k">Tickets held</div>
                  <div className="stat-v num">
                    {leg.heldBps !== undefined ? (Number(leg.heldBps) / 10000).toFixed(2) : "—"}
                  </div>
                </div>
                <div>
                  <div className="stat-k">Share of round</div>
                  <div className="stat-v num">
                    {leg.share !== undefined ? `${(leg.share * 100).toFixed(2)}%` : "—"}
                  </div>
                </div>
                <div>
                  <div className="stat-k">Won so far</div>
                  <div className="stat-v num">{formatUsdc(leg.totalWon, 0)}</div>
                </div>
                <div>
                  <div className="stat-k">House edge</div>
                  <div className="stat-v num">
                    {leg.feeBps !== undefined ? `${Number(leg.feeBps) / 100}%` : "—"}
                  </div>
                </div>
              </div>
            </section>

            <Pipeline pool={pool} leg={leg} />

            <div className="grid-main">
              <MegapotCard leg={leg} pool={pool} />

              <div className="card">
                <div className="card-head">
                  <h2>Contracts in this route</h2>
                </div>
                <p className="card-hint">
                  Every address is live. Follow any of them to check the figures on this page
                  yourself.
                </p>
                {[
                  ["Confidential pool", addresses.megaPot, poolChain.id, "Ethereum Sepolia"],
                  ["Prize inbox", addresses.prizeInbox, poolChain.id, "Ethereum Sepolia"],
                  ["Ticket agent", addresses.ticketAgent, BASE_SEPOLIA_ID, "Base Sepolia"],
                  ["Megapot jackpot", addresses.jackpot, BASE_SEPOLIA_ID, "Base Sepolia"],
                ].map(([label, addr, chain, net]) => (
                  <div className="row" key={String(label)}>
                    <span className="row-k">
                      {label}
                      <span className="chip">{net as string}</span>
                    </span>
                    <span className="row-v">
                      <a
                        className="mono"
                        href={explorerLink(chain as number, addr as string)}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: "var(--text-dim)", fontWeight: 500 }}
                      >
                        {shortAddress(addr as string)} ↗
                      </a>
                    </span>
                  </div>
                ))}
                <div className="status" style={{ marginTop: 16 }}>
                  <span>
                    Nothing on this page is confidential — it is all pool-aggregate activity, at a
                    granularity the pool already publishes. Which depositor ends up with the money
                    is decided back on Ethereum, under encryption.{" "}
                    <Link href="/app" style={{ color: "var(--gold)" }}>
                      Back to the app →
                    </Link>
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </>
    </Shell>
  );
}
