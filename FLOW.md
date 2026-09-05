# MegaPot — the flow, and every privacy boundary in it

What happens end to end across both chains, and at each step: **what is encrypted, what gets
decrypted, where that decryption physically happens, what is revealed, and what never is.**

Every claim below cites the line that makes it true. If a line moves, the claim should be
re-checked rather than trusted.

---

## The one fact that organises everything

> **The money is always public. Only the map from money → person is encrypted.**

Every cross-chain amount derives from `harvest()`, which reads nothing but public aggregates
(`yieldSource.totalAssets() − deployedPrincipal`, in `MegaPot.harvest`).

**No encrypted value ever crosses the bridge, and no bridged value is derived from any per-user
quantity.** That is why the entire Base leg — ticket purchases, winnings, CCTP transfers — can be
completely public and still cost zero privacy.

---

## The three mechanisms

FHEVM has exactly three dispositions for a ciphertext handle. Which one a value receives decides
everything about it.

| Marked by | Who can decrypt | Where the plaintext appears |
| --- | --- | --- |
| `FHE.allow(h, user)` | that user, and only them | **their browser tab, and nowhere else** |
| `FHE.makePubliclyDecryptable(h)` | the KMS; then anyone may post the result | **on-chain, public forever** |
| `FHE.allowThis(h)` alone | **nobody** | nowhere — no key path exists, ever |

`allowThis` is the important one. It lets the *contract* compute on a value homomorphically while
leaving no party — user, keeper, governance, or Zama — able to read it.

### How a user decryption actually works

1. The browser generates an **ephemeral keypair** and signs an EIP-712 request (`zama.ts`).
2. The relayer forwards it to the KMS, which checks the on-chain ACL for `allow(h, user)`.
3. The KMS **re-encrypts** the value under the browser's ephemeral public key.
4. The browser decrypts locally.

The plaintext never exists on the relayer, in the KMS output, or on any server. One signature
covers every handle for the session.

### How a public decryption actually works

1. A contract marks a handle `makePubliclyDecryptable`.
2. The KMS threshold-decrypts it and **signs the cleartext**.
3. Anyone submits `(cleartext, signature)` on-chain; `FHE.checkSignatures` verifies it.

The proof is what authorises the value — not the caller. Both of MegaPot's public decryptions are
therefore permissionless to finalise.

---

## Stage by stage

### Ethereum Sepolia — the encrypted domain

**1 · Wrap USDC → cUSDC** *(public, deliberately)*

A plain ERC-20 transfer. **The amount is visible.** This is decoupled on purpose: wrap once, in a
round number, unlinked from anything you later do with the pool. Your cUSDC balance is then an
`euint64` that ERC-7984 `allow`s to you.

**2 · Deposit** *(encrypted in your browser)*

`createEncryptedInput(pot, you).add64(amount).encrypt()` runs client-side. The amount never leaves
your machine in plaintext. On-chain, `FHE.fromExternal` (`:284`) verifies a ZK proof binding the
ciphertext to **this contract and your address** — it cannot be replayed anywhere else.

Then, all under encryption:

| What | Disposition | Line |
| --- | --- | --- |
| `_balance[user] += received` | `allow` → you | `:797` |
| ticket range `[cursor, cursor+amount)` | `allow` → you | `:743-744` |
| `_cursor` advances | `allowThis` **only** | `:741-742` |
| `_pendingDeploy += received` | `allowThis` **only** | `:292` |

Even *"did you actually have enough?"* stays encrypted: ERC-7984 computes
`transferred = select(success, amount, 0)`, so a failed deposit is indistinguishable from a
successful one.

→ **Public:** that you called `deposit`. Nothing about the amount.

**3 · Round closes — REVEAL #1**

`makePubliclyDecryptable(cursorSnapshot)` (`:379`) → KMS signs → `finalizeEntries` verifies with
`checkSignatures` (`:396`) and stores `totalTickets` as a plaintext `uint64`.

> **Revealed: the pool's total stake.** Never an individual deposit. Every deposit between two
> closes hides inside that batch — batch size is the anonymity set.

It *must* be revealed: `FHE.rem(rand, totalTickets)` (`:418`) needs a plaintext modulus, and the
principal sits in a public yield venue anyway.

**4 · Unwrap for deployment — REVEAL #2**

`requestDeploy` (`:502`) burns the pending cUSDC; the OpenZeppelin wrapper marks the burned amount
publicly decryptable.

> **Revealed: the batch aggregate of undeployed deposits.** The sum, never the parts.

---

### Ethereum → Base — value leaves the encrypted domain

**5 · `harvest()`** — entirely plaintext (`:534`). Splits realised surplus into public
`ticketBudget` (raw USDC) and public `prizeReserve` (wrapped cUSDC, but a public `uint64`).

> Where no ERC-4626 venue exists for the pool's USDC — which is the case on Sepolia — the same two
> buckets are funded directly by `fundTicketBudget` (`:581`) and `fundPrize` (`:595`). Both are
> pull-based and plaintext; neither changes anything below.

**6 · `bridgeToMegapot`** (`:571`)

```solidity
bridge.depositForBurn(amount, megapotDomain, ticketAgent, address(asset), bytes32(0), maxFee, 2000);
```

| Parameter | Value | Why it matters |
| --- | --- | --- |
| `mintRecipient` | `ticketAgent` | **Fixed at burn time.** The keeper cannot redirect it. |
| `destinationCaller` | `bytes32(0)` | **Anyone** may complete the transfer on Base. |
| `minFinalityThreshold` | `2000` | Hard finality — slow, no fee. |

**7 · Off-chain attestation** — the keeper polls Circle's attestation service, which signs once
the burn reaches finality. *The keeper never holds the funds.*

**8 · `receiveMessage` on Base** — permissionless. USDC mints to the agent, and only the agent.

---

### Base Sepolia — fully public, and that is fine

**9 · `buyTickets`** (`MegapotTicketAgent.buyTickets`) — `purchaseTickets(referrer, amount, address(this))`.
The agent holds the position in its own name. Pooled bps accounting, not NFTs, so there is no
receiver hook to get wrong.

**10 · Megapot's own draw** — `runJackpot(bytes32)`, randomness from **Pyth Entropy**. This is
*their* contract: not ours, not FHE, not confidential. Whether the pool won is plainly visible in
`usersInfo(agent).winningsClaimable`.

**11 · `claimWinnings`** (`agent:146`) — permissionless; it can only ever move value *into* the agent.

> Nothing here leaks anything about a depositor, because nothing here is derived from a per-user
> quantity. It is pool-aggregate money, at a granularity MegaPot already publishes.

---

### Base → Ethereum — value re-enters

**12 · `bridgeHome`** (`agent:179`) — burns to `homeRecipient`, which is `immutable` (`agent:53`).
**Not even governance can change where the money comes back to.**

**13 · `receiveMessage` on Ethereum** — mints to `PrizeInbox`.

**14 · `inbox.flush()`** (`PrizeInbox.flush`) — permissionless. The inbox has **no owner and no
rescue function**; its entire ABI is `flush / pending / pot / asset`. One exit exists.

**15 · `fundPrize`** (`:595`) — pull-based `safeTransferFrom(msg.sender)`, wrapped into
`prizeReserve` (a public `uint64`).

> The inbox exists to make the no-loss rule *structural*. If CCTP minted straight into the pool,
> arriving winnings would be indistinguishable from freshly unwrapped deposits waiting to be
> invested — and one keeper mistake would turn principal into prize money, or the reverse.

---

### Back under encryption — the part that matters

**16 · Draw — never decrypted by anyone**

```solidity
euint64 ticket = FHE.rem(FHE.randEuint64(), r.totalTickets);   // :418
FHE.allowThis(ticket);                                          // :419 — the only ACL call it ever gets
```

No `allow`. No `makePubliclyDecryptable`. Not now, not later, not by anyone: **not you, not the
keeper, not governance, not Zama.**

**17 · Claim — the outcome never touches the chain**

```solidity
ebool  hit   = FHE.and(FHE.ge(ticket, range.lower), FHE.lt(ticket, range.upper));
euint64 award = FHE.select(hit, r.unclaimed, award);            // :452
```

`hit` is never decrypted. A winning claim and a losing claim produce the **same call, the same
events, and the same storage-write shape**. You learn the result by user-decrypting your own
balance in your browser and comparing it to before.

**18 · Withdraw** — encrypted throughout (`:325-338`). `min(want, balance)` under encryption; if
the buffer is short, `sent = 0` and your balance is untouched — also under encryption.
`lastWithdrawnOf(you)` is `allow`ed to you (`:338`) so you can see what actually landed.

**19 · Sweep — REVEAL #3**

`makePubliclyDecryptable(r.unclaimed)` (`:473`) → `checkSignatures` (`:487`).

> **Revealed: *whether* the round's prize was won.** `unclaimed == prize` → the ticket landed on
> dead space and nobody held it. `unclaimed == 0` → someone did.
>
> **Not revealed: who.** The anonymity set is everyone who called `claim` that round — which is
> why claiming is cheap and rational for every depositor, winner or not.

---

## The reveal ledger

Every plaintext this protocol ever produces, in one place.

| # | When | What becomes public | What stays hidden | Line |
| --- | --- | --- | --- | --- |
| 1 | `closeEntries` | total pool stake | every individual deposit | `:379` |
| 2 | `requestDeploy` | batch aggregate awaiting deployment | its composition | `:504` |
| 3 | `finalizeSweep` | *whether* a prize was won | *who* won it | `:473` |

Plus everything inherently public: wrap amounts, `prizeReserve`, `deployedPrincipal`,
`ticketBudget`, all Base-side activity, and all CCTP transfers.

---

## Never revealed — no key path exists

- the **winning ticket** (`:419`)
- every intermediate `ebool hit` (`:452`)
- the live `_cursor` between closes (`:741-742`)
- the live `_pendingDeploy` between deployments (`:292`)
- **who won**

---

## What a watcher of both chains learns

Exact yield routed to Megapot · tickets bought and the pool's share of the round · whether Megapot
paid out and how much · the exact prize that came home · **nothing whatsoever about any individual
depositor.**

---

## Cross-chain trust model

The keeper **can**: stall. Never bridge, never buy tickets, never claim, never close a round.

The keeper **cannot**: steal, redirect, or learn anything encrypted.

| Property | Enforced by |
| --- | --- |
| Outbound destination cannot be changed | CCTP fixes `mintRecipient` at burn time |
| Return destination cannot be changed | `homeRecipient` is `immutable` (`agent:53`) |
| Winnings cannot become principal | `PrizeInbox` has one exit and no owner |
| Anyone can complete a stalled transfer | `destinationCaller = bytes32(0)` |
| Anyone can finalise a decryption | the KMS proof authorises the value, not the caller |

Liveness depends on the keeper. Custody does not.

---

## Residual leaks, stated plainly

1. **Aggregate stake** is revealed at each round close.
2. **Whether** a prize was claimed is revealed at each sweep.
3. **Metadata.** That address X deposited, claimed or withdrew at time T is public. Amounts are
   hidden; participation and timing are not. **A pool with one depositor has no anonymity set at
   all**, and correlation across time is a real attack on a thin pool.
4. **Claim gas scales with your ticket-range count** (the loop at `:446`), so that count is
   observable. It is independent of whether you won.

---

## Testnet caveat

**Steps 12–15 do not run on testnet.** Base Sepolia's Megapot settles in `TestTokenUSDC`, which
CCTP cannot carry in either direction, so the agent is deployed with
`tokenMessenger = address(0)` and says so (`bridgeEnabled()` → false).

The CCTP burn itself *is* verified against the live contract in the fork tests. The return leg
closes only on mainnet, where Megapot v1 settles in real USDC.
