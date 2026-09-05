import type { Abi, Address } from "viem";

/**
 * Live testnet deployment. Filled from `deployments/*.json` via `.env.local`.
 * The pool is on Ethereum Sepolia (where the Zama Protocol runs); the lottery leg is on Base
 * Sepolia (where Megapot runs).
 */
const addr = (v: string | undefined) => (v ?? "") as Address;

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

export const megaPotAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "encAmount", type: "bytes32" },
      { name: "proof", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "encAmount", type: "bytes32" },
      { name: "proof", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "function", name: "restake", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [],
  },

  // ciphertext handles
  {
    type: "function",
    name: "confidentialBalanceOf",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "lastWithdrawnOf",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "rangesOf",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "lower", type: "bytes32" },
          { name: "upper", type: "bytes32" },
          { name: "round", type: "uint64" },
        ],
      },
    ],
  },

  // public state
  { type: "function", name: "prizeReserve", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "settledTickets", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "ticketBudget", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "deployedPrincipal",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "roundsLength", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "entryRound", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "depositsPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "megapotSpendBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "MAX_RANGES", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "canCompact",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "hasClaimed",
    stateMutability: "view",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "user", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "getRound",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "drawTime", type: "uint64" },
          { name: "claimDeadline", type: "uint64" },
          { name: "totalTickets", type: "uint64" },
          { name: "prize", type: "uint64" },
          { name: "state", type: "uint8" },
          { name: "cursorSnapshot", type: "bytes32" },
          { name: "ticket", type: "bytes32" },
          { name: "unclaimed", type: "bytes32" },
        ],
      },
    ],
  },
  { type: "function", name: "keeper", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "startRound",
    stateMutability: "nonpayable",
    inputs: [{ name: "drawTime", type: "uint64" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "closeEntries",
    stateMutability: "nonpayable",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "finalizeEntries",
    stateMutability: "nonpayable",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "totalTickets", type: "uint64" },
      { name: "decryptionProof", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "draw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "claimWindow", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "requestSweep",
    stateMutability: "nonpayable",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "finalizeSweep",
    stateMutability: "nonpayable",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "unclaimedAmount", type: "uint64" },
      { name: "decryptionProof", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fundPrize",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "fundTicketBudget",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "bridgeToMegapot",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "maxFee", type: "uint256" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

export const prizeInboxAbi = [
  { type: "function", name: "flush", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pending", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;

export const confidentialUsdcAbi = [
  {
    type: "function",
    name: "wrap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "setOperator",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "until", type: "uint48" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "isOperator",
    stateMutability: "view",
    inputs: [
      { name: "holder", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "confidentialBalanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
] as const satisfies Abi;

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
