import type { Abi, Address } from "viem";

/**
 * Deployment addresses. Fill these in from `deployments/<network>.json` after running
 * `npx hardhat megapot:deploy`, via `.env.local` (see `.env.local.example`).
 */
export const addresses = {
  megaPot: (process.env.NEXT_PUBLIC_MEGAPOT ?? "") as Address,
  confidentialUSDC: (process.env.NEXT_PUBLIC_CUSDC ?? "") as Address,
  usdc: (process.env.NEXT_PUBLIC_USDC ?? "") as Address,
};

export const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 11155111);

export const isConfigured = () =>
  Boolean(addresses.megaPot && addresses.confidentialUSDC && addresses.usdc);

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
  // --- confidential actions ---
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

  // --- confidential views (ciphertext handles) ---
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

  // --- public views ---
  { type: "function", name: "prizeReserve", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "settledTickets", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
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
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const satisfies Abi;
