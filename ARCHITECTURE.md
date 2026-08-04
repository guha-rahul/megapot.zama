# MegaPot — architecture

A confidential no-loss lottery whose prize is played on the real Megapot jackpot.

Two protocols, two chains, one confidential ledger. This document explains why it is shaped that
way, what each piece does, and exactly where the privacy and trust boundaries fall.

---

## 1. The constraint that forces the shape

The design is not two chains by preference. It is two chains because the two things it needs
cannot coexist:

| | Deployed on | Not on |
| --- | --- | --- |
| **Zama Protocol** (FHE) | Ethereum `1`, Ethereum Sepolia `11155111`, Polygon Amoy `80002`, local `31337` | **Base** — `ZamaConfig` reverts `ZamaProtocolUnsupported` |
| **Megapot** | Base `8453`, Base Sepolia `84532` | Everywhere else |

`@fhevm/solidity` routes its coprocessor addresses off `block.chainid`. There is no Base entry, so
a contract doing FHE cannot exist there. Megapot exists only on Base. Therefore the confidential
ledger lives on Ethereum and the lottery position lives on Base, joined by Circle's CCTP.

**This costs no privacy.** Everything that happens on Base is pool-aggregate — ticket spend,
winnings, transfers — which MegaPot publishes in the clear anyway. Which *depositor* ends up with
the money is decided on the Ethereum side, under encryption.

---

## 2. The two halves

```
        ETHEREUM (Zama Protocol)                          BASE (Megapot)
  ┌──────────────────────────────────────┐        ┌──────────────────────────────────┐
  │                                      │        │                                  │
  │  ConfidentialUSDC  (ERC-7984)        │        │   MegapotTicketAgent             │
  │    wraps USDC, encrypted balances    │        │     buys tickets in its own name │
  │            │                         │        │     claims winnings              │
  │            ▼                         │        │     bridges proceeds home        │
  │  MegaPot                             │        │            │                     │
  │    encrypted per-user ledger         │        │            ▼                     │
  │    encrypted ticket space            │        │   BaseJackpot  (live Megapot)    │
  │    encrypted draw + winner           │        │     pooled bps accounting        │
  │    ticketBudget ──────────┐          │        │     runJackpot / withdrawWinnings│
  │    prizeReserve ◄───┐     │          │        │                                  │
  │                     │     │          │        └──────────────────────────────────┘
  │  PrizeInbox ────────┘     │          │                     ▲        │
  │    winnings, one exit     │          │                     │        │
  │            ▲              │          │                     │        │
  └────────────┼──────────────┼──────────┘                     │        │
               │              │                                │        │
               │              └────── CCTP burn ───────────────┘        │
               └───────────────────── CCTP mint ────────────────────────┘
```

### Ethereum side

| Contract | Responsibility |
| --- | --- |
| `ConfidentialUSDC` | ERC-7984 wrapper over USDC. Balances and transfers are ciphertexts. Wrapping is a public, one-off act decoupled from anything the pool later does. |
| `MegaPot` | The pool. Confidential ledger, encrypted ticket space, rounds, draws, claims, rollovers, and the two ends of the Megapot route. |
| `PrizeInbox` | The only address Megapot winnings may be minted to. Its sole function forwards them into the prize reserve. |
| `ERC4626YieldSource` | Optional. Routes principal into any ERC-4626 vault so the pool earns the yield that funds prizes. |

### Base side

| Contract | Responsibility |
| --- | --- |
| `MegapotTicketAgent` | Holds the pool's Megapot position. Buys tickets, claims winnings and referral fees, burns proceeds to CCTP addressed at `PrizeInbox`. |
| `IBaseJackpot` | Interface to the live Megapot, taken verbatim from the verified implementation, not from docs. |

---

## 3. Which Megapot

Two generations are live. We integrate the older one, deliberately:

| | `BaseJackpot` **(ours)** | `Jackpot` |
| --- | --- | --- |
| Base mainnet | `0xbEDd4F2beBE9E3E636161E644759f3cbe3d51B95` | `0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2` |
| Base Sepolia | `0x6f03c7BCaDAdBf5E6F5900DA3d56AdD8FbDac5De` | **none** |
| Tickets | pooled `ticketsPurchasedTotalBps` | ERC-721 NFTs |
| Buy | `purchaseTickets(referrer, value, recipient)` | `buyTickets(Ticket[], recipient, …)` |

Two reasons. First, **`BaseJackpot` is the only Megapot with a testnet**, so the entire integration
can be exercised for real before it touches mainnet — and the interface is identical on both
networks. Second, its pooled-bps accounting makes a contract a first-class participant with no NFT
custody or receiver hooks to get wrong; `usersInfo[agent]` is simply a mapping entry.

---

## 4. Value flow, end to end

```
 depositor            MegaPot (Ethereum)                   Agent (Base)         Megapot
 ─────────            ──────────────────                   ────────────         ───────
  wrap USDC ─────►  ConfidentialUSDC
  deposit(enc) ──►  balance += enc        ── ticket range allocated (encrypted)
                    pendingDeploy += enc
                          │
        keeper: requestDeploy ─► unwrap batch aggregate ─► invest into ERC-4626
                          │
        keeper: harvest ──► surplus split
                              ├─ (1 − bps) ─► prizeReserve   (funds the confidential draw)
                              └─      bps  ─► ticketBudget
                                              │
        keeper: bridgeToMegapot ─── CCTP burn ─┴──────────►  mint to agent
                                                             buyTickets ────► purchaseTickets
                                                                                    │
                                                             claimWinnings ◄── withdrawWinnings
                                              CCTP burn ◄──── bridgeHome
       PrizeInbox ◄── mint ──────────────────────────────────────┘
            │
            └── flush() ─► fundPrize ─► prizeReserve
                                            │
        keeper: startRound → closeEntries → finalizeEntries → draw
                                            │
  claim() ◄──── select(hit, prize, 0) ──────┘        (winner and amount stay encrypted)
```

Two steps round-trip through Zama's KMS — `closeEntries` and `requestSweep` publish a handle with
`FHE.makePubliclyDecryptable`, an off-chain relayer decrypts it, and anyone submits the cleartext
with its proof, verified on-chain by `FHE.checkSignatures`. The proof authorises the value, not the
caller, so those calls are permissionless.

---

## 5. The ticket space — O(1) odds

Odds are exactly proportional to stake, with **no per-depositor loop anywhere** in a draw or a
claim.

The pool keeps one *encrypted cursor* over a global ticket space. A deposit of `a` claims the
half-open range `[cursor, cursor + a)` and advances the cursor by `a`:

```
        alice 1,000        bob 3,000            alice 500
   ├──────────────────┼───────────────────────┼─────────┤
   0               1,000                   4,000     4,500   ← cursor (encrypted)
```

Because the cursor is a ciphertext, an individual deposit never moves a public number. The
cursor's running total is revealed exactly once per round, at `closeEntries` — so every deposit in
that window hides inside the batch aggregate.

A draw picks an encrypted ticket uniformly in `[0, totalTickets)`. A depositor claims by proving
homomorphically that it landed in one of their own ranges:

```solidity
ebool   hit   = FHE.and(FHE.ge(ticket, range.lower), FHE.lt(ticket, range.upper));
euint64 award = FHE.select(hit, r.unclaimed, award);
```

Every claimer runs identical code and every claimer's balance updates identically. A winning claim
and a losing claim are indistinguishable on-chain: same call, same gas, same events, same state
diff shape.

**Dead tickets and rollovers.** Withdrawing shrinks your ranges from the top by exactly the amount
taken out. Released tickets become *dead* — inside `[0, totalTickets)`, owned by nobody. A draw
landing there finds no claimant and the prize rolls into the next round via
`requestSweep` → `finalizeSweep`. That is the price of keeping stake sizes private, and it behaves
like a rollover jackpot.

**Compaction is rate-limited.** A depositor holds at most `MAX_RANGES` (4) ranges; the fifth
deposit folds them into one, releasing the old ones as dead tickets. Folding is capped at once per
round (`canCompact`) because it is the one cheap way to manufacture dead tickets — without the cap,
anyone could `restake()` in a loop until nearly every draw rolled over and the pool stalled.

---

## 6. Confidentiality model

| Quantity | On-chain form | Who can read it |
| --- | --- | --- |
| Deposit amount | `euint64` ciphertext | you |
| Pool balance | `euint64` ciphertext | you |
| Odds (ticket range) | two `euint64` ciphertexts | you |
| Winning ticket | `euint64` ciphertext | **nobody** |
| Who won / how much | `select(hit, prize, 0)` folded into balances | the winner |
| Withdrawal amount | `euint64` ciphertext | you |
| Pooled principal, prize size, round timing | plaintext | everyone |
| Ticket spend and winnings on Base | plaintext | everyone |

### What leaks, and why

1. **`finalizeEntries` reveals the ticket cursor total** — the sum of all stake. It has to be
   plaintext: `FHE.rem` needs a public modulus to pick a uniform ticket, and the principal sits in
   a public yield venue regardless. Deposits between two closes hide inside the batch, so batch
   size is the anonymity set.

2. **`finalizeSweep` reveals *whether* a round was won, never by whom.** The anonymity set is
   everyone who called `claim` for that round — and claiming is cheap and rational whether you won
   or not, which is exactly why the design pushes every depositor to claim every round.

3. **Everything on Base is public.** Pool-aggregate only. The per-user split never crosses.

Also worth naming: the winning ticket is `rand() mod totalTickets`, biased by at most
`totalTickets / 2^64` — under 1e-13 for any realistic pool.

---

## 7. Trust model

**The keeper is a liveness dependency, not a custodian.**

- `depositForBurn` names `mintRecipient` at burn time and Circle's attestation mints only there.
  `homeRecipient` on the agent and `ticketAgent` on the pool are the only destinations either side
  can address. A compromised keeper can stall the flow; it cannot redirect a unit of it.
- The agent's only value path is `pay token in → tickets → winnings → CCTP burn to homeRecipient`.
- `harvest`, `claim`, `fundPrize`, `finalizeEntries`, `finalizeSweep`, `PrizeInbox.flush` and
  `claimWinnings` are all permissionless. The keeper is required only for scheduling.

**`PrizeInbox` makes the no-loss rule structural.** Winnings arrive as a CCTP mint, which needs a
fixed destination chosen at burn time. If that destination were the pool, arriving USDC would be
indistinguishable from freshly unwrapped deposits waiting to be invested, and one keeper mistake
would turn principal into prize money or the reverse. So winnings land in a contract with no owner,
no rescue function, and exactly one exit: `pot.fundPrize`.

**Principal is never spent on prizes.** `harvest()` can only move `totalAssets − deployedPrincipal`.
`invest()` refuses to sweep `ticketBudget` back into principal. `refillBuffer` and
`emergencyUnwind` credit only what the venue actually returned — crediting the full request after a
partial fill would strand principal that the next harvest would mistake for yield.

**Governance holds:** `setYieldSource`, `setKeeper`, `setMegapotRoute`, `setMegapotSpendBps`,
`emergencyUnwind`, and the agent's `setReferrer` / `sweep`.

---

## 8. Economics — read this before setting `megapotSpendBps`

Routing yield through Megapot is a deliberate trade, which is why it **defaults to zero**.

| | Base Sepolia | Base mainnet |
| --- | --- | --- |
| `feeBps` (house edge) | 1,500 | 3,000 |
| `referralFeeBps` | 1,000 | 1,000 |
| Round duration | 300 s | 86,280 s |

At mainnet's 3,000 bps, every unit of yield played on Megapot has an expected return of ~0.70. The
pool is buying variance: steady small yield converted into a chance at a much larger prize. That is
the entire PoolTogether/Megapot thesis, but the edge is real and it compounds per round.

**Self-referral does not work.** The live contract reverts with `"Cannot refer yourself"`, verified
on Base Sepolia; `setReferrer` rejects the agent's own address locally so a keeper gets a clean
error. A pool cannot rebate its own edge. The agent can still *receive* referral fees when another
integrator points purchases at it, and those come home the same way winnings do.

`MegaPot` is not obliged to use Megapot at all. With `megapotSpendBps = 0` it is a self-contained
confidential no-loss lottery funded purely by yield.

---

## 9. Verified addresses

Every address below was read directly off-chain, not taken from documentation. See
`contracts/megapot/addresses.md` for the probe record.

### Megapot
| | Chain | Address |
| --- | --- | --- |
| `BaseJackpot` | Base Sepolia | `0x6f03c7BCaDAdBf5E6F5900DA3d56AdD8FbDac5De` (impl `0x271ba7aC4CD936aabeE15B5b16C1695407912333`) |
| `BaseJackpot` | Base mainnet | `0xbEDd4F2beBE9E3E636161E644759f3cbe3d51B95` |
| `TestTokenUSDC` | Base Sepolia | `0xA4253E7C13525287C56550b8708100f93E60509f` — 6dp, **public `mint()`** |

### CCTP V2
| | Chains | Address |
| --- | --- | --- |
| `TokenMessengerV2` | both Sepolias | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| `MessageTransmitterV2` | both Sepolias | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| `TokenMessengerV2` | both mainnets | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| `MessageTransmitterV2` | both mainnets | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |

Domains: Ethereum `0`, Base `6`.

### USDC
Ethereum Sepolia `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` · Base Sepolia
`0x036CbD53842c5426634e7929541eC2318f3dCF7e` · Base mainnet
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

### Zama, Ethereum Sepolia
ACL `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D` · Coprocessor
`0x92C920834Ec8941d2C77D188936E1f7A6f49c127` · KMSVerifier
`0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A`

---

## 10. The testnet seam

**On testnet the two halves do not connect, and no amount of code fixes it.** Base Sepolia's
Megapot settles in `TestTokenUSDC`, which CCTP cannot carry — in either direction. On mainnet,
Megapot v1 settles in real USDC and the loop closes.

So the agent is deployed with `tokenMessenger = address(0)` on testnet. It says so explicitly:
`bridgeEnabled()` returns false and `bridgeHome` reverts `BridgingDisabled` rather than failing
obscurely deep inside CCTP. Governance's `sweep` is the escape hatch for testnet winnings.

Each leg is still exercised for real:

| Leg | How it is verified |
| --- | --- |
| Megapot | Live Base Sepolia jackpot — real ticket purchases, real referral fees |
| CCTP | Live `TokenMessengerV2` — real USDC burned, real `MessageSent` |
| Confidential pool | Live Ethereum Sepolia — real Zama coprocessor, relayer and KMS |

There is a second testnet gap: no ERC-4626 USDC venue on Sepolia matches Circle's USDC, so there is
no yield to skim. `fundPrize` and `fundTicketBudget` exist for this — permissionless, pull-based
entry points that stand in for `harvest()` where no venue exists.

---

## 11. Testing strategy

Two suites, two Hardhat configs, and they must not share build output.

```
npx hardhat test                                            # 29 — confidential mechanics
npx hardhat --config hardhat.megapot.config.ts test         # 11 — live deployments
```

| Suite | Config | Network | What it proves |
| --- | --- | --- | --- |
| `test/local` | `hardhat.config.ts` | 31337, Zama mock | Ticket space, draws, claims, rollovers, withdrawals, fairness over 40 live rounds |
| `test/live` | `hardhat.megapot.config.ts` | Base Sepolia fork | Real Megapot purchases and referral fees; real CCTP burns |

**Why the split is mandatory.** `@fhevm/hardhat-plugin` deploys the mock coprocessor at startup and
refuses any chain but 31337, so a forked test cannot use it. FHE cannot be forked at all — the
coprocessor is an off-chain service that will not process a local fork's events. The Megapot and
CCTP legs have no FHE in them, so they run under a plugin-free config against real chains.

**They need separate `cache` and `artifacts` directories.** The FHE plugin rewrites
`@fhevm/solidity/config/ZamaConfig.sol` at compile time to point at the local mock. Compiling the
same sources without the plugin bakes in the real Sepolia/mainnet addresses instead. Share an
artifacts directory and whichever config compiled last silently wins — the failure surfaces much
later as an opaque ACL revert.

---

## 12. Status

Unaudited. Testnet only. No timelock on governance, no audit, no bug bounty. Depositors also bear
the smart-contract and market risk of whatever yield venue the pool points at — "no-loss" is a
protocol rule about how prizes are funded, not a guarantee about the venue.
