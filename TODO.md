# TODO

Open work, in rough priority order. Each item says what it costs, so nothing here is a surprise.

Items 1–5 of the previous list are **done** — see [Closed](#closed) at the bottom for what
happened to each, including the one that turned out to be unrecoverable rather than fixed.

---

## 1 · No round has ever completed on this deployment

The pool was redeployed for the allocation slider, so round #0 is the first round it has ever run
and it is still `Open`. The full lifecycle — `closeEntries` → `finalizeEntries` → `draw` → `claim`
→ `requestSweep` → `finalizeSweep` — has been exercised end to end **in tests** (62 of them) and
piecemeal on the previous deployment, but not yet start-to-finish on this one.

**Cost:** four keeper transactions plus two KMS round-trips, and about three days of waiting unless
the draw time is brought forward. Worth doing before anyone judges it, because a `Settled` round in
the history table is the difference between "it works" and "it says it works".

## 2 · The `MEGA` track has never been drawn

`setMegapotAllocation` is proven on-chain — 25% on the live pool mints a `MEGA` range as expected —
but the second track has never had entries closed or a draw run, so `megapotShareBps()` still
returns 0. That is *correct*: the split needs both tracks' ticket totals revealed, and only one has
been. It does mean the Megapot half of the product is untested outside the local suite.

**Cost:** the same four keeper calls again, against track 1, plus a prize in the `MEGA` reserve to
draw for.

## 3 · The yield loop is wired but has never actually earned

`MockYieldVault` and `ERC4626YieldSource` are deployed and `setYieldSource` is set, so `invest()`,
`harvest()` and `topUpBuffer()` all work rather than reverting `YieldSourceNotSet`. Nothing has
been invested yet, though, so no yield has ever been realised on this deployment.

`bufferTarget` is set to 25 USDC in anticipation, which is currently a forward-looking number:
`deployedPrincipal` is zero, so every deposit is fully liquid and withdrawals cannot fail for
liquidity today. The buffer only starts mattering once `invest()` runs.

**Cost:** `requestDeploy` → KMS decrypt → `finalizeUnwrap` → `invest`, then mint USDC into the
vault to simulate a yield accrual, then `harvest`. Needs more testnet USDC than the deployer
currently holds (1 USDC).

## 4 · Bridging is disabled on this testnet pair, by necessity

Base Sepolia's Megapot settles in `TestTokenUSDC`, which CCTP cannot carry. The agent is deployed
with `tokenMessenger = address(0)` and says so. **This is not a bug and is not fixable on testnet**
— on mainnet Megapot settles in real USDC and the loop closes. It is listed here so nobody
mistakes a deliberate hole for an oversight.

## 5 · Megapot's real ticket cost is misstated in the app

`ticketPrice()` returns `1000000`, but the fee is taken *before* tickets are credited, so a ticket
actually costs `price / (1 - feeBps/10_000)` — **1.176 MPUSDC** on testnet at 15%, and ~1.43 USDC
on Base mainnet at 30%. The Megapot panel and `ARCHITECTURE.md` §8 both quote the raw price.

**Cost:** one formula, two places.

## 6 · `FLOW.md` cites line numbers that have moved

It references `MegaPot.sol:379`, `:504`, `:473` and others. The contract has been rewritten twice
since — two tracks, then the allocation slider — so those anchors are wrong. The prose is still
accurate; only the coordinates are stale.

**Cost:** re-anchor to function names rather than line numbers, so it cannot rot again.

## 7 · No keyed RPC

`NEXT_PUBLIC_RPC_URL` is unset, so the app falls back to public endpoints. It now uses a viem
`fallback` across several per chain and shows an explicit banner when none of them answer, which
makes throttling survivable rather than fatal — but a keyed Alchemy or Infura endpoint is still the
right answer under real load.

**Cost:** one environment variable in the Vercel project, then a redeploy (it is a
`NEXT_PUBLIC_` var, so it is inlined at build time and a save alone will not do it).

## 8 · The repository is private

The bounty requires *"open source in a public GitHub repository."* It is currently private by the
owner's choice.

**Cost:** `gh repo edit --visibility public`. The history has been scanned for key material — the
only matches are the well-known public hardhat test mnemonic and an empty placeholder.

---

## Closed

**Wrap and authorise are one transaction.** `ConfidentialUSDC.wrapAndAuthorize` collapses
`wrap` + `setOperator`, and `wrapWithPermit` folds the ERC-20 approval in too where the token
supports EIP-2612. Proven on the live deployment.

**Withdraw is "at any time" for real.** `topUpBuffer()` is permissionless, so a short buffer is
repairable by anyone rather than only by a keeper.

**A yield source is wired.** See item 3 for what remains.

**Round #0 stuck in `Claimable`** — obsolete. That round belonged to the previous deployment.

**The 60 USDC in the old `PrizeInbox` is unrecoverable, not merely unflushed.** `PrizeInbox.pot` is
`immutable` and points at the pre-track pool, whose `MEGA()` does not exist — so `flush()` reverts
rather than forwarding. Testnet funds, and the cost of an immutable that is otherwise doing exactly
its job: it is *because* the destination cannot be changed that winnings can only ever become the
prize depositors are playing for.
