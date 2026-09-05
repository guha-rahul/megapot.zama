# TODO

Open work, in rough priority order. Each item says what it costs, so nothing here is a surprise.

---

## 1 · Collapse wrap + authorise into one transaction — needs redeploy

**Today a new depositor signs three transactions before they own anything:**

| # | Call | Contract |
| --- | --- | --- |
| 1 | `approve(cUSDC, amount)` | USDC |
| 2 | `wrap(to, amount)` | ConfidentialUSDC |
| 3 | `setOperator(pool, until)` | ConfidentialUSDC |

Steps 2 and 3 are both on **ConfidentialUSDC, which is ours** — deployed from
`contracts/token/ConfidentialUSDC.sol` by `0xcF1B8469…6B43` (creation tx
`0x4e09188a…92ec`). Zama owns the coprocessor, ACL and KMS; it does not own this token.

### The change

```solidity
/// Wrap and authorise a spender in one call. `setOperator` keys off msg.sender, so this can only
/// live on the token itself — a helper contract would set the operator for *itself*, not the user.
function wrapAndAuthorize(address to, uint256 amount, address operator, uint48 until) external {
    wrap(to, amount);
    _setOperator(msg.sender, operator, until);
}
```

Pair it with **EIP-2612 `permit`**, which Sepolia USDC supports — verified on-chain:
`version() = 2`, `DOMAIN_SEPARATOR()`, `nonces()` and `permit(...)` all present. That turns the
approval into a free off-chain signature.

| | Transactions | Wallet prompts |
| --- | --- | --- |
| Today | 3 | 3 |
| `wrapAndAuthorize` | 2 | 2 |
| **+ permit** | **1** | 2 (one gasless) |

### Cost

- Redeploy `ConfidentialUSDC`, **and** `MegaPot` — the pool holds `cToken` as `immutable`.
- New addresses in `deployments/sepolia.json` and `frontend/.env.local`.
- The ~6 cUSDC currently wrapped must be re-wrapped. No depositor funds are stranded; the only
  live position is the keeper's 5.

### Alternative that needs no redeploy

**EIP-5792 `wallet_sendCalls`** batches at the wallet layer. Already available in the installed
stack — wagmi 2.19.5 exports `useSendCalls`, `useCapabilities`, `useCallsStatus`,
`useWaitForCallsStatus`. Gate it on `useCapabilities()` and fall back to sequential sends, because
support is wallet-dependent (MetaMask yes; Phantom almost certainly not).

---

## 2 · Withdraw is not yet "at any time"

The spec requires exiting with full principal whenever you like. Today `withdraw` pays from the
pool's cUSDC buffer, and if that is short it pays **0** and the depositor waits for a keeper
`refillBuffer`.

It cannot simply be inlined: the withdrawal amount is encrypted, so the contract cannot size the
refill it would need.

**Proposed:** a public buffer target plus a **permissionless** `topUpBuffer()` that pulls from the
yield source until the buffer reaches it. A short buffer then becomes repairable by anyone in the
same block, rather than only by the keeper.

---

## 3 · No yield source is wired

`yieldSource == address(0)` on the live pool, so nothing accrues and prizes are funded explicitly
through `fundPrize` / `fundTicketBudget`. The spec asks for prizes to be *the pool's accrued
yield*.

The obstacle is real and worth restating: **Sepolia has no healthy ERC-4626 venue over Circle's
USDC.**

- **Aave Sepolia** advertises **77.88% APY** — but on a market with **22 USDC of free liquidity**
  and **108.6% utilisation**. It cannot return principal, which breaks the no-loss guarantee far
  worse than a stale buffer does. It also uses its *own* test USDC (`0x94a9…E4C8`), not Circle's,
  so adopting it kills the CCTP/Megapot leg.
- A small (~100 USDC) Aave position would show real accrual at bounded risk — demo-grade, not
  production-shaped.

**Recommendation:** keep prizes explicitly funded on testnet and wire `ERC4626YieldSource` on
mainnet, where real venues exist. The harvest-only-surplus logic is already written and covered by
the local suite, including the partial-fill accounting bug.

---

## 4 · Round #0 is stuck in `Claimable`

It was drawn, won and claimed; its claim deadline passed on 2026-08-04. Nobody called
`requestSweep`, so it never advanced to `Settled`. Harmless, but it made the UI advertise a
1 USDC prize that no longer existed (since fixed in the hero). Sweeping it would tidy the state.

---

## 5 · The 60 USDC in the PrizeInbox is unflushed

`0xA621d4Fc…f2E7` holds **60 USDC** that has not been folded into `prizeReserve`. One call:

```shell
npx hardhat megapot:flush-inbox --network sepolia
```

Then open a round so there is something to play for.

---

## 6 · Docs overstate the testnet blocker

`ARCHITECTURE.md` §10 and the README both say CCTP "cannot carry the token". That understates what
actually works: CCTP moves USDC between Ethereum Sepolia and Base Sepolia perfectly well — burn
limits are 10,000,000 per message in both directions, and `getLocalToken` maps the pair correctly.

The single real blocker is that **Megapot's Sepolia jackpot settles in `MPUSDC`**, a free-mint test
token, rather than the chain's real USDC. Outbound bridging works; the agent just cannot spend
what arrives. Reword both.

---

## 7 · Megapot economics are misstated in two places

`ticketPrice()` returns `1000000`, but the 15% fee is taken **before** tickets are credited, so the
real cost is **1.176 MPUSDC per ticket** on testnet (`25 spent → 21.25 tickets`, verified against
our own agent's position) and **~1.43 USDC** on Base mainnet at 30%.

Fix the app's Megapot panel and `ARCHITECTURE.md` §8, which both imply the nominal price.
