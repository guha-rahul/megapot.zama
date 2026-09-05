# MegaPot — app

The dapp for the confidential no-loss lottery. It reads **two live testnets at once**: the
confidential pool on Ethereum Sepolia (where the Zama Protocol runs) and the real Megapot jackpot
position on Base Sepolia (where Megapot runs). Everything private happens in the browser —
amounts are encrypted client-side with the Zama relayer SDK before they are submitted, and your
balance and odds are decrypted locally after a single signature.

## Run it

```shell
npm install
cp .env.local.example .env.local     # already contains the live testnet addresses
npm run dev
```

`NEXT_PUBLIC_*` values are inlined at build time, so re-run `npm run build` after changing them.

## What's on the page

| Section | Reads | Notes |
| --- | --- | --- |
| Prize hero | Sepolia | live prize, round state, ticket total, countdown |
| Deposit & play | your wallet | guided setup, then deposit / withdraw / claim |
| Your position | ciphertext handles | blank until you sign once; then balance, tickets and odds |
| How it works | — | why the protocol spans two chains |
| What's encrypted | — | the claim itemised, including the two things that leak |
| Megapot leg | Base Sepolia | the pool's real share of the live jackpot, and the house edge |

The **claim** button is the one to watch. Claiming is the same transaction whether you won or
lost — same call, same gas, same events — so the only way to learn the outcome is to decrypt your
own balance, which nobody else can do.

## First run

You need Sepolia ETH for gas and Sepolia USDC ([Circle's faucet](https://faucet.circle.com)). The
app then walks you through the two one-time steps — wrap USDC into confidential cUSDC, authorise
the pool to move it — before any encrypted deposit is possible.

## Notes for whoever touches this next

- **Cross-origin isolation is required, not optional.** `next.config.mjs` sets COOP/COEP because
  TFHE's threaded WASM needs `SharedArrayBuffer`. Verified at runtime:
  `crossOriginIsolated === true`. If you embed this page somewhere that loads third-party
  resources, those headers have to be relaxed and encryption drops to single-threaded.
- **Wallets are discovered over EIP-6963**, not through the `wagmi/connectors` barrel — that
  barrel pulls in the entire Coinbase account SDK (and its optional native deps) for a connector
  this app never uses, and it breaks the production build.
- **Both chains live in one wagmi config.** Base Sepolia reads pass `chainId` explicitly, so the
  Megapot panel works without asking anyone to switch networks.
- **The first encryption is slow.** The relayer SDK pulls a multi-megabyte WASM bundle on first
  use; it is imported lazily so it stays out of the initial page load.
- **Watch CSS source order.** `.chip { display: inline-flex }` is declared after the responsive
  nav rules, so anything hiding a chip at a breakpoint needs extra specificity
  (`.nav-right .nav-badge`) or it silently loses on source order.

## Preflight

```shell
npm run preflight
```

Checks what neither `tsc` nor `next build` can: that both chains are reachable, every configured
address has code on the chain it is meant to be on, the pool's `cToken()`/`asset()` match the env,
the Zama infrastructure the SDK depends on is live, and that `createInstance` + `encrypt` actually
work end to end. Section 6 statically guards three bugs that already shipped once — importing the
SDK's CDN shim, calling the non-idempotent `initSDK()` unguarded, and letting the SDK follow the
wallet's network instead of a pinned RPC.

## Verified

Rendered against the live deployment at 390 / 768 / 1280px: no horizontal overflow at any width,
no console or page errors, cross-origin isolation active.
