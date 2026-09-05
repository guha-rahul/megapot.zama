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

## 2 · The `MEGA` track is settled but has never been drawn

Progress: `setMegapotAllocation(2500)` mints a `MEGA` range on the live pool, and round 0 on that
track has been opened, closed and finalised — so the two-phase KMS reveal
(`closeEntries` → `publicDecrypt` → `finalizeEntries`) is proven on this deployment. It revealed
**0.25 tickets**.

That number is worth reading carefully, because it is the documented model behaving exactly as
described: 0.25 tickets were minted at a 25% allocation, then a withdrawal released half of them —
and the cursor does not rewind, so the revealed total is *gross mints including dead tickets*, not
live stake. This is the drift described under `harvest`, visible on-chain for the first time.

What remains is the draw itself, which needs a prize in the `MEGA` reserve. The deployer wallet is
at 0 USDC, so this is blocked on funds rather than on code.

**Cost:** any amount of Sepolia USDC into `fundPrize(1, …)`, then `draw` → `claim` →
`requestSweep` → `finalizeSweep`.

## 3 · The yield loop is wired but has never actually earned

`MockYieldVault` and `ERC4626YieldSource` are deployed and `setYieldSource` is set, so `invest()`,
`harvest()` and `topUpBuffer()` all work rather than reverting `YieldSourceNotSet`. Nothing has
been invested yet, though, so no yield has ever been realised on this deployment.

`bufferTarget` is set to 25 USDC in anticipation, which is currently a forward-looking number:
`deployedPrincipal` is zero, so every deposit is fully liquid and withdrawals cannot fail for
liquidity today. The buffer only starts mattering once `invest()` runs.

**Cost:** `requestDeploy` → KMS decrypt → `finalizeUnwrap` → `invest`, then mint USDC into the
vault to simulate a yield accrual, then `harvest`. Blocked on funds: the deployer wallet is at
0 USDC.

## 4 · Bridging is disabled on this testnet pair, by necessity

CCTP itself is fine here — 10,000,000-unit burn limit in both directions, `getLocalToken` maps
correctly, verified against the live contracts in `test/live/Cctp.fork.ts`. The blocker is that
**Base Sepolia's Megapot settles in `TestTokenUSDC`**, so there is no USDC on that side for CCTP to
carry home. The agent is therefore deployed with `tokenMessenger = address(0)` and says so.

**This is not a bug and is not fixable on testnet** — on mainnet Megapot settles in real USDC and
the loop closes with no contract change. Listed here so nobody mistakes a deliberate hole for an
oversight, or spends a day debugging the bridge.

## 5 · No keyed RPC

`NEXT_PUBLIC_RPC_URL` is unset, so the app falls back to public endpoints. It now uses a viem
`fallback` across several per chain and shows an explicit banner when none of them answer, which
makes throttling survivable rather than fatal — but a keyed Alchemy or Infura endpoint is still the
right answer under real load.

**Cost:** one environment variable in the Vercel project, then a redeploy (it is a
`NEXT_PUBLIC_` var, so it is inlined at build time and a save alone will not do it).

## 6 · The repository is private

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

**Megapot's real ticket cost is documented.** `ARCHITECTURE.md` §8 now carries both the nominal
`ticketPrice()` and the actual 1.176 / ~1.43 cost per ticket, with the reason they differ. The app
never quoted a ticket price, so there was nothing to correct there.

**`FLOW.md` no longer cites line numbers.** Re-anchored to function names, which survive a rewrite.

**The docs no longer blame CCTP.** See item 4 for what is actually true.

**Round #0 stuck in `Claimable`** — obsolete. That round belonged to the previous deployment.

**The 60 USDC in the old `PrizeInbox` is unrecoverable, not merely unflushed.** `PrizeInbox.pot` is
`immutable` and points at the pre-track pool, whose `MEGA()` does not exist — so `flush()` reverts
rather than forwarding. Testnet funds, and the cost of an immutable that is otherwise doing exactly
its job: it is *because* the destination cannot be changed that winnings can only ever become the
prize depositors are playing for.
