# MegaPot

A **confidential no-loss lottery** — PoolTogether, encrypted end to end with the
[Zama Protocol](https://docs.zama.ai/protocol), with its prize played on the real
[Megapot](https://megapot.io) jackpot on Base.

> Deposit into a shared pool → the pool's principal earns yield → the yield buys real Megapot
> lottery tickets → whatever comes back is awarded to one depositor by a confidential draw →
> nobody ever loses principal.
>
> **And nobody can see any of it.** Your deposit, your balance, your odds, the winning ticket,
> who won, what they won, and your withdrawal are all FHE ciphertexts on-chain.

Built on [megayield](../megayield)'s yield-funded-lottery architecture, rebuilt around the Zama
Protocol so the entire per-user ledger is confidential.

📐 **[ARCHITECTURE.md](./ARCHITECTURE.md)** — the full design: why it spans two chains, the
encrypted ticket space, the trust model, and every verified address.

🔐 **[FLOW.md](./FLOW.md)** — the end-to-end flow across both chains, and every privacy boundary
in it: what is encrypted, what gets decrypted and *where*, what is revealed, and what never is.

📋 **[TODO.md](./TODO.md)** — open work, each item with its real cost.

---

## Try it live

**https://megapot-zama.pages.dev** — connect a wallet on Ethereum Sepolia and run the whole
cycle. There is an open round with a prize in it right now.

You need two free things first:

| What | Where |
| --- | --- |
| Sepolia ETH, for gas | [sepoliafaucet.com](https://sepoliafaucet.com) or [Google's faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia) |
| Sepolia USDC, the pool's token | [faucet.circle.com](https://faucet.circle.com) — pick *Ethereum Sepolia* |

The pool accepts exactly one token: Circle's Sepolia USDC at
[`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`](https://sepolia.etherscan.io/address/0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238).
Several other things on Sepolia are also called "USDC" — Aave's test token in particular — and the
app will tell you if you paste one of them.

Then: **Deposit** → wait for a **Draw** (or run one yourself from the keeper console, if you hold
the keeper key) → **Claim** and decrypt what you won → **Withdraw**, any time, in full.

## Deployed contracts

**Ethereum Sepolia**
| Contract | Address |
| --- | --- |
| `MegaPot` | [`0xD5548Cb5b3E2d772f5B72f399f5D52107631e04b`](https://sepolia.etherscan.io/address/0xD5548Cb5b3E2d772f5B72f399f5D52107631e04b) |
| `ConfidentialUSDC` | [`0xc8995AA91E962f530798eeDC5bB89a86e1d1Dac1`](https://sepolia.etherscan.io/address/0xc8995AA91E962f530798eeDC5bB89a86e1d1Dac1) |
| `PrizeInbox` | [`0xeF8AFB44460a395f753d685F61C5C8850e6F0E87`](https://sepolia.etherscan.io/address/0xeF8AFB44460a395f753d685F61C5C8850e6F0E87) |
| `MockYieldVault` | [`0xAE4c2d6cA31e45acd1CDDe30F8de54ce4a87d478`](https://sepolia.etherscan.io/address/0xAE4c2d6cA31e45acd1CDDe30F8de54ce4a87d478) |
| `ERC4626YieldSource` | [`0xa7eD29e0E537d27276af76E3642549Fd81Bb9eb1`](https://sepolia.etherscan.io/address/0xa7eD29e0E537d27276af76E3642549Fd81Bb9eb1) |

**Base Sepolia**
| Contract | Address |
| --- | --- |
| `MegapotTicketAgent` | [`0xB3089B1Bff1555D7F7cf88DD236bbE99C4E59730`](https://sepolia.basescan.org/address/0xB3089B1Bff1555D7F7cf88DD236bbE99C4E59730) |
| Megapot `BaseJackpot` (theirs) | [`0x6f03c7BCaDAdBf5E6F5900DA3d56AdD8FbDac5De`](https://sepolia.basescan.org/address/0x6f03c7BCaDAdBf5E6F5900DA3d56AdD8FbDac5De) |

Real run against the live Zama coprocessor, relayer and KMS:

```
[2] Depositing an encrypted amount (relayer encrypts client-side)
    pool balance 5 — a ciphertext on-chain, readable only by you
[3] Opening a round and closing entries
    asking the KMS to publicly decrypt the aggregate…
    5 tickets in play (verified on-chain against a real KMS signature)
[5] round 0 drawn — prize 1 over 5 tickets
    winning ticket 0x47ff91d0…0500 (encrypted; nobody can read it)
[6] 🎉 won 1 USDC — visible only to you
```

And on Base, real tickets in the live jackpot:

```
tickets held   212500 bps of 2924000     (~7.3% of the round)
spent / won    25 / 0
house edge     1500 bps
```

---

## What's actually encrypted

| Quantity | On-chain | Who can read it |
| --- | --- | --- |
| Your deposit amount | `euint64` ciphertext | you |
| Your pool balance | `euint64` ciphertext | you |
| Your odds (ticket range) | two `euint64` ciphertexts | you |
| The winning ticket | `euint64` ciphertext | **nobody** |
| Who won / how much | `select(hit, prize, 0)` folded into balances | the winner |
| Your withdrawal | `euint64` ciphertext | you |
| Pooled totals, prize size, Megapot activity | plaintext | everyone |

The pool-wide aggregate is public **by necessity** — the money sits in a real yield venue and a
real lottery, where its size is visible anyway. What MegaPot hides is every per-user quantity.
[Two things do leak](./ARCHITECTURE.md#what-leaks-and-why), both named and bounded.

---

## How it works

### The ticket space — O(1) odds

Odds are exactly proportional to stake, with no per-depositor loop anywhere in a draw or a claim.
The pool keeps one *encrypted cursor*; a deposit of `a` claims `[cursor, cursor + a)`:

```
        alice 1,000        bob 3,000            alice 500
   ├──────────────────┼───────────────────────┼─────────┤
   0               1,000                   4,000     4,500   ← cursor (encrypted)
```

Because the cursor is a ciphertext, an individual deposit never moves a public number. Claiming
proves homomorphically that the drawn ticket fell in one of your ranges — and a winning claim is
indistinguishable from a losing one: same call, same gas, same events.

### Why two chains

Zama is not deployed on Base; Megapot exists only on Base. So the confidential ledger lives on
Ethereum, the lottery position lives on Base, and Circle's CCTP joins them — with the destination
fixed at burn time, so the keeper is a liveness dependency rather than a custodian.
[Full reasoning →](./ARCHITECTURE.md#1-the-constraint-that-forces-the-shape)

### Before you allocate yield to Megapot

Every depositor sets their own share with `setMegapotAllocation`, and the default is **0**. There
is deliberately no pool-wide multiplier: the yield is yours, so the choice is too.

Megapot takes 3,000 bps on Base mainnet, so every unit of yield played there returns ~0.70 in
expectation. You are buying variance, not edge — a rarer shot at a much larger number, with your
principal untouched at any setting.
[Economics →](./ARCHITECTURE.md#8-economics--read-this-before-allocating-yield-to-megapot)

---

## Contracts

| Contract | Role |
| --- | --- |
| `MegaPot.sol` | The pool: confidential ledger, encrypted ticket space, rounds, draws, claims, rollovers, yield and Megapot plumbing. |
| `ConfidentialUSDC.sol` | ERC-7984 confidential wrapper around USDC. |
| `PrizeInbox.sol` | Where Megapot winnings land. No owner, no rescue — one exit, into the prize. |
| `MegapotTicketAgent.sol` | Holds the pool's position in the live Megapot on Base. |
| `IBaseJackpot.sol` | Megapot's interface, taken from the verified implementation. |
| `ICCTP.sol` | Circle CCTP V2, ditto. |
| `ERC4626YieldSource.sol` | Routes principal into any ERC-4626 vault. No arbitrary-call surface. |

---

## Build and test

```shell
npm install
npx hardhat test                                        # 29 — confidential mechanics
npx hardhat --config hardhat.megapot.config.ts test     # 11 — live Base Sepolia
```

```
  MegaPot — confidential no-loss lottery          MegapotTicketAgent — live Base Sepolia
    deposits         ✔ 4                            ✔ reads the live jackpot's config
    confidentiality  ✔ 2                            ✔ buys real tickets as a CONTRACT
    round entries    ✔ 2                            ✔ leaves no standing approval
    yield            ✔ 2                            ✔ cannot refer itself (live rule)
    draws            ✔ 5                            ✔ claims real referral fees
    rollovers        ✔ 3                            ✔ keeper gating / overspend
    withdrawals      ✔ 6                          CCTP V2 — live Base Sepolia
    access control   ✔ 3                            ✔ our interface matches the live ABI
  MegaPot — fairness                                ✔ burns real USDC to a fixed recipient
    ✔ proportional odds over 30 live rounds         ✔ refuses an unapproved burn
    ✔ never pays a depositor with no tickets
```

The two suites need **separate configs and separate artifact directories** — the FHE plugin
rewrites `ZamaConfig.sol` at compile time, so sharing build output makes whichever config compiled
last silently win. [Why →](./ARCHITECTURE.md#11-testing-strategy)

---

## Deploy

```shell
cp .env.example .env          # add a funded PRIVATE_KEY

# 1 — the confidential pool (Ethereum Sepolia; Zama is not on Base)
npx hardhat megapot:deploy --network sepolia

# 2 — the ticket agent, pointed at the inbox printed above
npx hardhat --config hardhat.megapot.config.ts megapot-base:deploy \
  --inbox <PrizeInbox> --network baseSepolia

# 3 — wire the route (bps = share of yield played on Megapot)
npx hardhat megapot:wire-route --agent <Agent> --bps 8000 --network sepolia
npx hardhat megapot:live-check --network sepolia
```

### Drive it

```shell
# the whole confidential flow, live
npx hardhat megapot:live-flow --amount 5 --prize 1 --network sepolia

# the Megapot leg
npx hardhat --config hardhat.megapot.config.ts megapot-base:faucet --amount 50 --network baseSepolia
npx hardhat --config hardhat.megapot.config.ts megapot-base:buy    --amount 10 --network baseSepolia
npx hardhat --config hardhat.megapot.config.ts megapot-base:status --network baseSepolia
```

| Depositor | | Keeper | |
| --- | --- | --- | --- |
| `megapot:deposit` | encrypt client-side, deposit | `megapot:start-round` | open a round |
| `megapot:withdraw` | confidential payout | `megapot:close-entries` | freeze + reveal the ticket total |
| `megapot:claim` | wins and losses look identical | `megapot:draw` | run the draw |
| `megapot:balance` | decrypt your own balance and odds | `megapot:sweep` | roll an unclaimed prize forward |
| | | `megapot:harvest` | skim yield into the prize |
| | | `megapot:fund-tickets` | fund the Megapot budget directly |
| | | `megapot:bridge-tickets` | burn the budget to CCTP for Base |
| | | `megapot:flush-inbox` | fold arrived winnings into the prize |

---

## App

A Next.js dapp lives in [`frontend/`](./frontend), wired to the live deployment on **both**
testnets — the confidential pool on Ethereum Sepolia and the real Megapot position on Base
Sepolia, side by side, without asking anyone to switch networks.

```shell
cd frontend && cp .env.local.example .env.local && npm install && npm run dev
```

Amounts are encrypted in the browser with the Zama relayer SDK before they are submitted; your
balance and odds decrypt locally after one signature. Encrypted values render as ciphertext until
you unlock them, which is the whole point made visible:

| Panel | Live data |
| --- | --- |
| Prize hero | round #0, prize, tickets in play, state — read from Sepolia |
| Deposit & play | guided wrap → authorise → deposit, then withdraw / claim |
| Your position | balance, tickets, win chance — ciphertext until you decrypt |
| Megapot leg | the pool's real 5.67% share of the live Base Sepolia jackpot, and its 15% edge |

Claiming is the same transaction whether you won or lost — same call, same gas, same events — so
the only way to learn the outcome is to decrypt your own balance.

Verified at 390 / 768 / 1280px: no horizontal overflow, no console errors, and
`crossOriginIsolated === true` (the Zama WASM needs it).

---

## The testnet seam

**On testnet the two halves do not connect, and no amount of code fixes it.**

It is worth being precise about *why*, because the obvious explanation is wrong. CCTP works fine on
this pair: the Sepolia and Base Sepolia `TokenMessengerV2` contracts both carry Circle's USDC, with
a 10,000,000-unit burn limit in each direction, and `getLocalToken` maps correctly. We verified it
against the live contracts (`test/live/Cctp.fork.ts`).

The blocker is one step further along. **Base Sepolia's Megapot settles in `TestTokenUSDC`, not
USDC** — so there is no USDC on the Base side for CCTP to carry home. The bridge is not the
limitation; what the jackpot pays out in is. On mainnet Megapot v1 settles in real USDC and the
loop closes with no change to any contract here.

The agent is therefore deployed with bridging disabled and says so explicitly — `bridgeEnabled()`
is false and `bridgeHome` reverts `BridgingDisabled` rather than failing obscurely inside CCTP.

Each leg is still verified against real contracts — live Megapot, live CCTP, live Zama.

### The yield source

Sepolia has no healthy ERC-4626 vault over Circle's USDC. Aave's market there runs above 100%
utilisation on a couple of dozen dollars of liquidity and uses its own test token, so pointing at
it would produce a demo that reverts rather than one that works.

So the deployment includes a **`MockYieldVault`** — a plain ERC-4626 vault — wired through
`ERC4626YieldSource`. This is not a stub standing in for the yield path; it *is* the yield path,
executing for real on a public testnet: `invest()` deploys principal into it, `harvest()` pulls
only the surplus above `deployedPrincipal`, and `topUpBuffer()` pulls principal back when the
withdrawal buffer runs short. All three run on-chain and can be watched.

**Swapping in a real venue is one argument and no contract change:**

```shell
npx hardhat megapot:deploy --network mainnet --vault 0x<aave-or-morpho-vault>
```

`ERC4626YieldSource` speaks plain ERC-4626, and its constructor refuses any vault not denominated
in the pool's own asset. `MegaPot.setYieldSource` checks the same thing again from its side, and
will re-point a venue as long as no principal is currently deployed — so a misconfiguration is
recoverable rather than terminal.

The vault has to be *funded* to earn anything, which on testnet means minting USDC into it. That is
the one part of the loop that a real venue does by itself.

---

## Status

Unaudited. Testnet only. Do not use with real funds. No timelock on governance, no audit, no bug
bounty. Depositors also bear the smart-contract and market risk of whatever yield venue the pool
points at, plus Megapot's house edge on any yield routed there — "no-loss" is a protocol rule about
how prizes are funded, not a guarantee about the venue.
