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

📋 **[TODO.md](./TODO.md)** — open work, each item with its real cost: the one-transaction
onboarding redeploy, the withdraw-liquidity gap, and why no yield source is wired on testnet.

---

## Live on testnet

Deployed and driven end to end, against real contracts on both chains.

**Ethereum Sepolia**
| Contract | Address |
| --- | --- |
| `MegaPot` | [`0x14a451a725ee757834887A4FA5A0fDCA8510E1Ca`](https://sepolia.etherscan.io/address/0x14a451a725ee757834887A4FA5A0fDCA8510E1Ca) |
| `ConfidentialUSDC` | [`0x84486e5C57C4Fb20934BD777FA51CE6341B3B46A`](https://sepolia.etherscan.io/address/0x84486e5C57C4Fb20934BD777FA51CE6341B3B46A) |
| `PrizeInbox` | [`0xA621d4Fc6B50Bab107e6B003D4Ea97d191EAf2E7`](https://sepolia.etherscan.io/address/0xA621d4Fc6B50Bab107e6B003D4Ea97d191EAf2E7) |

**Base Sepolia**
| Contract | Address |
| --- | --- |
| `MegapotTicketAgent` | [`0x84486e5C57C4Fb20934BD777FA51CE6341B3B46A`](https://sepolia.basescan.org/address/0x84486e5C57C4Fb20934BD777FA51CE6341B3B46A) |
| Megapot `BaseJackpot` (theirs) | [`0x6f03c7BCaDAdBf5E6F5900DA3d56AdD8FbDac5De`](https://sepolia.basescan.org/address/0x6f03c7BCaDAdBf5E6F5900DA3d56AdD8FbDac5De) |

> The pool and the agent share an address by coincidence — both were the first contract deployed
> from the same account on their respective chains, so `CREATE` produced the same result.

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

### Before you enable the Megapot route

`megapotSpendBps` **defaults to 0**. Megapot takes 3,000 bps on Base mainnet, so every unit of
yield played there returns ~0.70 in expectation. You are buying variance, deliberately.
[Economics →](./ARCHITECTURE.md#8-economics--read-this-before-setting-megapotspendbps)

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

**On testnet the two halves do not connect.** Base Sepolia's Megapot settles in `TestTokenUSDC`,
which CCTP cannot carry in either direction. The agent is deployed with bridging disabled and says
so explicitly (`bridgeEnabled()` is false; `bridgeHome` reverts `BridgingDisabled`). On mainnet,
Megapot v1 settles in real USDC and the loop closes.

Each leg is still verified against real contracts — live Megapot, live CCTP, live Zama. There is
also no ERC-4626 USDC venue on Sepolia matching Circle's USDC, so `fundPrize` and
`fundTicketBudget` stand in for `harvest()` where no venue exists.

---

## Status

Unaudited. Testnet only. Do not use with real funds. No timelock on governance, no audit, no bug
bounty. Depositors also bear the smart-contract and market risk of whatever yield venue the pool
points at, plus Megapot's house edge on any yield routed there — "no-loss" is a protocol rule about
how prizes are funded, not a guarantee about the venue.
