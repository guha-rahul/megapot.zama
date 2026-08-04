# MegaPot frontend

A Next.js dapp for the confidential no-loss lottery. Everything private happens in the browser:
amounts are encrypted client-side with the [Zama relayer SDK](https://docs.zama.ai/protocol)
before they are submitted, and your balance and odds are decrypted locally after a single
signature. The pool never sees a plaintext, and neither does anyone reading the chain.

## Run it

```shell
cd ..                                                  # repo root
npx hardhat megapot:deploy --network sepolia           # or --network localhost

cd frontend
cp .env.local.example .env.local                       # paste the addresses it printed
npm install
npm run dev
```

`NEXT_PUBLIC_*` values are inlined at build time, so re-run `npm run build` after changing them.

## What the UI does

| Panel | Reads | Notes |
| --- | --- | --- |
| Prize hero | public state | prize, round state, ticket total, pooled principal |
| Deposit & play | your wallet | wrap USDC → cUSDC, authorise the pool, deposit, withdraw, re-stake, claim |
| Your position | ciphertext handles | blank until you sign once; then balance, tickets and odds decrypt locally |

The **claim** button is the interesting one. Claiming a round is the same transaction whether you
won or lost — same call, same gas, same events. The only way to learn the outcome is to decrypt
your own balance before and after, which nobody else can do.

## Notes

- **Cross-origin isolation.** `next.config.mjs` sets COOP/COEP because TFHE's threaded WASM needs
  `SharedArrayBuffer`. If you embed this app somewhere that loads third-party resources, you will
  need to relax those headers and accept single-threaded encryption.
- **Wallets are discovered over EIP-6963**, not through `wagmi/connectors` — that barrel pulls in
  the whole Coinbase account SDK for a connector this app never uses.
- **The first encryption is slow.** The relayer SDK loads a multi-megabyte WASM bundle on first
  use; it is imported lazily so it stays out of the initial page load.
