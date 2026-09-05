import type { Abi, Address } from "viem";

// The pool's own ABIs are generated from the compiled artifacts — see scripts/gen-abi.mjs. They
// used to be written by hand here, which is how they drifted thirteen functions behind the
// contract without anything noticing.
export { megaPotAbi, prizeInboxAbi, confidentialUsdcAbi, yieldVaultAbi } from "./abi/generated";

/**
 * Live testnet deployment. Filled from `deployments/*.json` via `.env.local`.
 * The pool is on Ethereum Sepolia (where the Zama Protocol runs); the lottery leg is on Base
 * Sepolia (where Megapot runs).
 */
const addr = (v: string | undefined) => (v ?? "") as Address;

/** Track ids, mirroring `MegaPot.MAIN` / `MegaPot.MEGA`. */
export const MAIN = 0;
export const MEGA = 1;

/**
 * Which env vars are missing or malformed.
 *
 * `addr()` casts `undefined` to `""`, so without this a forgotten variable surfaces as a failed
 * read somewhere inside viem rather than as the configuration mistake it is.
 */
export function configIssues(): string[] {
  const required = {
    NEXT_PUBLIC_MEGAPOT: process.env.NEXT_PUBLIC_MEGAPOT,
    NEXT_PUBLIC_CUSDC: process.env.NEXT_PUBLIC_CUSDC,
    NEXT_PUBLIC_USDC: process.env.NEXT_PUBLIC_USDC,
  };
  return Object.entries(required).flatMap(([key, value]) => {
    if (!value) return [`${key} is not set`];
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return [`${key} is not a valid address: ${value}`];
    return [];
  });
}

export const addresses = {
  megaPot: addr(process.env.NEXT_PUBLIC_MEGAPOT),
  confidentialUSDC: addr(process.env.NEXT_PUBLIC_CUSDC),
  usdc: addr(process.env.NEXT_PUBLIC_USDC),
  prizeInbox: addr(process.env.NEXT_PUBLIC_PRIZE_INBOX),
  ticketAgent: addr(process.env.NEXT_PUBLIC_TICKET_AGENT),
  jackpot: addr(process.env.NEXT_PUBLIC_JACKPOT),
  /** Canonical Base Sepolia USDC — what CCTP mints on arrival. */
  usdcBase: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
};

export const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 11155111);
export const BASE_SEPOLIA_ID = 84532;

export const isConfigured = () => Boolean(addresses.megaPot && addresses.confidentialUSDC && addresses.usdc);
export const hasMegapotLeg = () => Boolean(addresses.ticketAgent && addresses.jackpot);

export const explorer = (chain: number) =>
  chain === BASE_SEPOLIA_ID ? "https://sepolia.basescan.org" : "https://sepolia.etherscan.io";

export const explorerLink = (chain: number, a: string, kind: "address" | "tx" = "address") =>
  `${explorer(chain)}/${kind}/${a}`;

/** Round lifecycle, mirroring `MegaPot.RoundState`. */
export const ROUND_STATES = [
  "Not started",
  "Entries open",
  "Closing entries",
  "Ready to draw",
  "Claimable",
  "Sweeping",
  "Settled",
] as const;




export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const satisfies Abi;

/** The Megapot leg on Base Sepolia — read-only in the UI. */
export const ticketAgentAbi = [
  { type: "function", name: "totalSpent", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalWon", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "totalReferralFees",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "totalBridged", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ticketsHeldBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimable", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "roundEndsAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;

export const jackpotAbi = [
  { type: "function", name: "ticketPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "userPoolTotal", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lpPoolTotal", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "ticketCountTotalBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "roundDurationInSeconds",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const satisfies Abi;
