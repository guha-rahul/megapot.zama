import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-network-helpers";
import * as dotenv from "dotenv";
import type { HardhatUserConfig } from "hardhat/config";

import "./tasks/megapot-base";

dotenv.config();

/** `??` does not catch empty strings, which is exactly what a blank line in .env produces. */
const env = (key: string, fallback: string) => {
  const v = process.env[key];
  return v && v.trim() !== "" ? v.trim() : fallback;
};

/**
 * The Base half of MegaPot — the ticket agent that plays the real Megapot lottery.
 *
 * It gets its own config because it has no FHE in it, and because `@fhevm/hardhat-plugin` refuses
 * to run on any chain but 31337 (it deploys the mock coprocessor at startup). Keeping the plugin
 * out of this config is what lets these tests fork the *live* Base Sepolia deployment instead of
 * running against a stand-in.
 *
 * It also needs its own `cache` and `artifacts` directories. The FHE plugin rewrites
 * `@fhevm/solidity/config/ZamaConfig.sol` at compile time to point at the local mock coprocessor;
 * compiling the same sources without the plugin bakes in the real Sepolia/mainnet addresses. Share
 * an artifacts directory between the two and whichever config compiled last silently wins.
 *
 *   npx hardhat --config hardhat.megapot.config.ts test test/MegapotAgent.fork.ts
 *   npx hardhat --config hardhat.megapot.config.ts megapot-base:deploy --network baseSepolia
 */
const MNEMONIC = env("MNEMONIC", "test test test test test test test test test test test junk");

/** A funded deployer: PRIVATE_KEY if set, otherwise the mnemonic (defaults to Hardhat's). */
const PRIVATE_KEY = env("PRIVATE_KEY", "");
const ACCOUNTS = PRIVATE_KEY
  ? [PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`]
  : { mnemonic: MNEMONIC, count: 10 };
const BASE_SEPOLIA_RPC = env("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org");
const BASE_RPC = env("BASE_RPC_URL", "https://mainnet.base.org");

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 800 }, viaIR: true },
  },
  networks: {
    hardhat: {
      chainId: 84532,
      forking: { url: BASE_SEPOLIA_RPC },
      accounts: { mnemonic: MNEMONIC, count: 10 },
    },
    baseSepolia: { url: BASE_SEPOLIA_RPC, chainId: 84532, accounts: ACCOUNTS },
    base: { url: BASE_RPC, chainId: 8453, accounts: ACCOUNTS },
  },
  paths: { sources: "./contracts", tests: "./test/live", cache: "./cache-megapot", artifacts: "./artifacts-megapot" },
  mocha: { timeout: 600000 },
};

export default config;
