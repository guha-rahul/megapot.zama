import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-network-helpers";
import * as dotenv from "dotenv";
import type { HardhatUserConfig } from "hardhat/config";

import "./tasks/live-flow";
import "./tasks/megapot";

dotenv.config();

/** `??` does not catch empty strings, which is exactly what a blank line in .env produces. */
const env = (key: string, fallback: string) => {
  const v = process.env[key];
  return v && v.trim() !== "" ? v.trim() : fallback;
};

const MNEMONIC = env("MNEMONIC", "test test test test test test test test test test test junk");

/** A funded deployer: PRIVATE_KEY if set, otherwise the mnemonic (defaults to Hardhat's). */
const PRIVATE_KEY = env("PRIVATE_KEY", "");
const ACCOUNTS = PRIVATE_KEY
  ? [PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`]
  : { mnemonic: MNEMONIC, count: 10 };


const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      // The Zama coprocessor requires transient storage (TSTORE/TLOAD).
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 800 },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      // chainId 31337 selects the local Zama mock coprocessor deployment.
      chainId: 31337,
      accounts: { mnemonic: MNEMONIC, count: 10 },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      accounts: ACCOUNTS,
    },
    sepolia: {
      url: env("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com"),
      chainId: 11155111,
      accounts: ACCOUNTS,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test/local",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 400000,
  },
};

export default config;
