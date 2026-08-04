/**
 * Live deployment addresses, every one of them read directly off-chain rather than taken from
 * documentation (see `contracts/megapot/addresses.md` for the probe results).
 */

export const DOMAIN = { ethereum: 0, base: 6 } as const;

export const CHAINS = {
  ethereumSepolia: 11155111,
  ethereum: 1,
  baseSepolia: 84532,
  base: 8453,
} as const;

/** Circle CCTP V2. One address per environment, shared across chains within it. */
export const CCTP = {
  testnet: {
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  },
  mainnet: {
    tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  },
} as const;

export const USDC = {
  ethereumSepolia: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  baseSepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
} as const;

/**
 * Megapot. The `BaseJackpot` generation is the integration target: it is the only one deployed on
 * a testnet, and its interface is identical on both networks.
 *
 * `payToken` is what the jackpot actually settles in. On Base Sepolia that is Megapot's own
 * `TestTokenUSDC`, **not** CCTP-transferable USDC — which is why the bridge and the lottery only
 * join up on mainnet.
 */
export const MEGAPOT = {
  baseSepolia: {
    jackpot: "0x6f03c7BCaDAdBf5E6F5900DA3d56AdD8FbDac5De",
    payToken: "0xA4253E7C13525287C56550b8708100f93E60509f",
    payTokenIsUsdc: false,
    roundSeconds: 300,
    feeBps: 1500,
  },
  base: {
    jackpot: "0xbEDd4F2beBE9E3E636161E644759f3cbe3d51B95",
    payToken: USDC.base,
    payTokenIsUsdc: true,
    roundSeconds: 86280,
    feeBps: 3000,
  },
} as const;

export function cctpFor(chainId: number) {
  return chainId === CHAINS.ethereum || chainId === CHAINS.base ? CCTP.mainnet : CCTP.testnet;
}

export function megapotFor(chainId: number) {
  if (chainId === CHAINS.base) return MEGAPOT.base;
  if (chainId === CHAINS.baseSepolia) return MEGAPOT.baseSepolia;
  throw new Error(`Megapot is only deployed on Base (8453) and Base Sepolia (84532), not ${chainId}`);
}

export function usdcFor(chainId: number) {
  switch (chainId) {
    case CHAINS.ethereumSepolia:
      return USDC.ethereumSepolia;
    case CHAINS.ethereum:
      return USDC.ethereum;
    case CHAINS.baseSepolia:
      return USDC.baseSepolia;
    case CHAINS.base:
      return USDC.base;
    default:
      throw new Error(`no known USDC for chain ${chainId}`);
  }
}

/** The Zama Protocol is only deployed on these chains; everywhere else `ZamaConfig` reverts. */
export function assertZamaSupported(chainId: number) {
  if (![CHAINS.ethereum, CHAINS.ethereumSepolia, 31337].includes(chainId as never)) {
    throw new Error(
      `The Zama Protocol is not deployed on chain ${chainId}. MegaPot's confidential half can only ` +
        `run on Ethereum (1), Ethereum Sepolia (11155111) or a local node (31337).`,
    );
  }
}
