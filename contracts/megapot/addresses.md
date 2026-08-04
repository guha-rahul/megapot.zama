# Verified deployment addresses

All read directly from chain on 2026-08-04, not from documentation.

## Megapot

| What | Chain | Address | Notes |
| --- | --- | --- | --- |
| `BaseJackpot` (integration target) | Base Sepolia | `0x6f03c7BCaDAdBf5E6F5900DA3d56AdD8FbDac5De` | impl `0x271ba7aC4CD936aabeE15B5b16C1695407912333`, 300s rounds, feeBps 1500 |
| `BaseJackpot` | Base mainnet | `0xbEDd4F2beBE9E3E636161E644759f3cbe3d51B95` | 86,280s rounds, feeBps 3000, settles in real USDC |
| `TestTokenUSDC` (MPUSDC) | Base Sepolia | `0xA4253E7C13525287C56550b8708100f93E60509f` | 6dp, **public `mint()`** — not CCTP-transferable |
| USDC | Base mainnet | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | |
| `Jackpot` (number-picking, NFT tickets) | Base mainnet | `0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2` | megayield's target — **mainnet only, no testnet** |
| `JackpotTicketNFT` | Base mainnet | `0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4` | |

## CCTP V2

| What | Chains | Address |
| --- | --- | --- |
| `TokenMessengerV2` | Ethereum Sepolia, Base Sepolia | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| `MessageTransmitterV2` | Ethereum Sepolia, Base Sepolia | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| `TokenMessengerV2` | Ethereum, Base mainnet | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| `MessageTransmitterV2` | Ethereum, Base mainnet | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| USDC | Ethereum Sepolia | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

Domains: Ethereum `0`, Base `6`.

## Zama Protocol

`@fhevm/solidity` routes on `block.chainid` and supports **1, 11155111, 31337** (0.13.x adds
80002). Base is not supported and reverts `ZamaProtocolUnsupported` — this is why the pool and the
lottery cannot share a chain.
