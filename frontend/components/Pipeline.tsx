"use client";

import { BASE_SEPOLIA_ID, addresses, explorerLink } from "../lib/contracts";
import { formatCountdown, formatUsdc, shortAddress } from "../lib/format";
import { useNow, type MegapotLeg, type PublicState } from "../lib/usePool";
import { poolChain } from "../lib/wagmi";

type Fig = { k: string; v: React.ReactNode };

function Stage({
  n,
  chain,
  chainId,
  title,
  state,
  note,
  figs,
  caveat,
  last,
  link,
}: {
  n: number;
  chain: string;
  chainId: number;
  title: string;
  state: "done" | "live" | "todo";
  note: React.ReactNode;
  figs?: Fig[];
  caveat?: React.ReactNode;
  last?: boolean;
  link?: string;
}) {
  return (
    <div className="pipe-stage" data-state={state}>
      <div className="pipe-rail">
        <div className="pipe-dot">{state === "done" ? "✓" : n}</div>
        {!last && <div className="pipe-line" />}
      </div>
      <div className="pipe-body">
        <div className="pipe-chain">{chain}</div>
        <div className="pipe-title">
          {title}
          {link && (
            <a
              href={explorerLink(chainId, link)}
              target="_blank"
              rel="noreferrer"
              className="chip mono"
              style={{ fontWeight: 500 }}
            >
              {shortAddress(link)} ↗
            </a>
          )}
        </div>
        <div className="pipe-note">{note}</div>
        {figs && figs.length > 0 && (
          <div className="pipe-figs">
            {figs.map((f) => (
              <div key={f.k}>
                <div className="pipe-fig-k">{f.k}</div>
                <div className="pipe-fig-v num">{f.v}</div>
              </div>
            ))}
          </div>
        )}
        {caveat && <div className="pipe-caveat">{caveat}</div>}
      </div>
    </div>
  );
}

/**
 * The cross-chain journey, with live figures read from both chains at each stop.
 *
 * Every stage below is a real on-chain step except the token substitution at stage 4, which is
 * labelled as what it is. Showing the true pipeline is more convincing than a staged one — each
 * address links to its explorer so any figure here can be checked independently.
 */
export function Pipeline({ pool, leg }: { pool: PublicState; leg: MegapotLeg }) {
  const now = useNow();

  const budget = pool.ticketBudget;
  const spent = leg.totalSpent;
  const won = leg.totalWon;

  // Proof that value crossed from the pool is bridged USDC sitting on the agent: you cannot hold
  // it on Base without both the burn and the mint having happened. `totalSpent` only shows the
  // agent bought tickets, and `totalBridged` counts the *return* leg — neither answers this.
  const bridged = leg.arrivedOnBase ?? 0n;
  const hasBridged = bridged > 0n;
  const hasPosition = (spent ?? 0n) > 0n;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Where the money goes</h2>
        <span className="chip">Ethereum Sepolia → Base Sepolia</span>
      </div>
      <p className="card-hint">
        Yield leaves the confidential pool, crosses to Base over Circle CCTP, and buys tickets in
        the live Megapot jackpot. Winnings return the same way and become the prize a confidential
        draw awards. Every figure below is read live from the chain it belongs to.
      </p>

      <div className="pipe">
        <Stage
          n={1}
          chain="Ethereum Sepolia"
          chainId={poolChain.id}
          title="Yield is earmarked"
          state={(budget ?? 0n) > 0n ? "live" : "done"}
          link={addresses.megaPot}
          note={
            <>
              <code className="mono">harvest()</code> splits realised yield: a configured share
              becomes the ticket budget, the rest funds the prize directly. Principal is never
              touched.
            </>
          }
          figs={[
            { k: "ticket budget", v: `${formatUsdc(budget)} USDC` },
            { k: "routed to Megapot", v: `${(pool.megapotSpendBps ?? 0) / 100}%` },
            { k: "prize reserve", v: `${formatUsdc(pool.prizeReserve)} USDC` },
          ]}
        />

        <Stage
          n={2}
          chain="Ethereum Sepolia → in flight"
          chainId={poolChain.id}
          title="Burned to CCTP"
          state={hasBridged ? "done" : "todo"}
          note={
            <>
              <code className="mono">depositForBurn</code> burns the USDC and names the recipient{" "}
              <em>at burn time</em>. Circle attests after hard finality; anyone can then complete
              the mint. The keeper can stall the transfer but cannot redirect it.
            </>
          }
          figs={[
            { k: "bridged so far", v: formatUsdc(bridged) },
            { k: "route", v: "domain 0 → 6" },
            { k: "finality", v: "hard (2000)" },
          ]}
          caveat={
            !hasBridged ? (
              <>
                <strong>Nothing has crossed yet.</strong> The route is wired, but{" "}
                <code className="mono">harvest()</code> has never run — there is no yield source on
                Sepolia — so no budget has ever been earmarked or burned.
              </>
            ) : undefined
          }
        />

        <Stage
          n={3}
          chain="Base Sepolia"
          chainId={BASE_SEPOLIA_ID}
          title="Minted to the ticket agent"
          state={hasBridged ? "done" : "todo"}
          link={addresses.ticketAgent}
          note={
            <>
              CCTP mints native USDC to the agent — and only the agent. From here the single
              permitted path is tickets, then winnings, then home.
            </>
          }
          figs={[
            { k: "arrived via CCTP", v: `${formatUsdc(bridged)} USDC` },
            { k: "spent on tickets", v: formatUsdc(spent) },
          ]}
        />

        <Stage
          n={4}
          chain="Base Sepolia"
          chainId={BASE_SEPOLIA_ID}
          title="Tickets bought"
          state={hasPosition ? "live" : "todo"}
          link={addresses.jackpot}
          note={
            <>
              <code className="mono">purchaseTickets</code> credits the agent directly — pooled
              accounting, not NFTs, so a contract is a first-class participant.
            </>
          }
          figs={[
            { k: "tickets held", v: leg.heldBps !== undefined ? (Number(leg.heldBps) / 10000).toFixed(2) : "—" },
            { k: "share of round", v: leg.share !== undefined ? `${(leg.share * 100).toFixed(2)}%` : "—" },
            { k: "jackpot pot", v: `${formatUsdc(leg.userPoolTotal, 0)}` },
            { k: "settles in", v: leg.roundEndsAt ? formatCountdown(Number(leg.roundEndsAt), now) : "—" },
          ]}
          caveat={
            <>
              {hasPosition && !hasBridged && (
                <>
                  <strong>This position was funded directly on Base, not bridged.</strong> The
                  tickets and the jackpot share below are real; the money to buy them did not come
                  through CCTP from the pool.
                  <br />
                  <br />
                </>
              )}
              <strong>Testnet substitution.</strong> Megapot&apos;s Sepolia jackpot settles in{" "}
              <code className="mono">MPUSDC</code>, its own free-mint test token — not the USDC CCTP
              delivers. The agent therefore pays in MPUSDC here. On Base <strong>mainnet</strong>{" "}
              Megapot settles in real USDC and the bridged funds pay directly, with no substitution.
            </>
          }
        />

        <Stage
          n={5}
          chain="Base Sepolia → Ethereum Sepolia"
          chainId={poolChain.id}
          title="Winnings come home"
          state={(won ?? 0n) > 0n ? "done" : "todo"}
          link={addresses.prizeInbox}
          note={
            <>
              Winnings bridge back to the <code className="mono">PrizeInbox</code> — an address with
              no owner and no rescue function, whose only exit is into the prize reserve. Winnings
              can never become principal.
            </>
          }
          figs={[
            { k: "won so far", v: `${formatUsdc(won)}` },
            { k: "claimable now", v: `${formatUsdc(leg.claimable)}` },
            { k: "house edge", v: leg.feeBps !== undefined ? `${Number(leg.feeBps) / 100}%` : "—" },
          ]}
        />

        <Stage
          n={6}
          chain="Ethereum Sepolia"
          chainId={poolChain.id}
          title="One depositor wins — privately"
          state={(pool.roundsLength ?? 0n) > 0n ? "done" : "todo"}
          link={addresses.megaPot}
          last
          note={
            <>
              Back under encryption. The draw picks a ticket nobody can decrypt, and every claim —
              winning or losing — is the same transaction. Only the winner ever learns the outcome,
              by decrypting their own balance.
            </>
          }
          figs={[
            { k: "rounds run", v: String(pool.roundsLength ?? 0n) },
            { k: "tickets in play", v: formatUsdc(pool.settledTickets, 0) },
            { k: "winner", v: <span className="cipher">encrypted</span> },
          ]}
        />
      </div>
    </div>
  );
}
