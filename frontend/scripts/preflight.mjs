#!/usr/bin/env node
/**
 * Preflight — verify the app can actually talk to what it is configured against.
 *
 * Written after three bugs that all had the same shape: the code was fine, but it was pointed at
 * something that could not answer.
 *
 *   1. `@zama-fhe/relayer-sdk/bundle` is a CDN shim whose body is
 *      `export const initSDK = window.relayerSDK.initSDK` — undefined under a bundler.
 *   2. `initSDK()` panics inside the WASM if called twice.
 *   3. The SDK's chain reads followed `window.ethereum`, so a wallet on the wrong network made
 *      `eip712Domain()` return `0x` on an address with no code.
 *
 * None of these are caught by `tsc` or `next build`. They need a live check.
 *
 *   npm run preflight
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JsonRpcProvider, getAddress, id } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- env
const env = {};
try {
  for (const line of readFileSync(join(here, "..", ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} catch {
  fail("no .env.local — copy .env.local.example first");
}

const RPC = env.NEXT_PUBLIC_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const BASE_RPC = env.NEXT_PUBLIC_BASE_RPC_URL || "https://sepolia.base.org";
const POOL_CHAIN = Number(env.NEXT_PUBLIC_CHAIN_ID || 11155111);
const BASE_CHAIN = 84532;

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};
function fail(m) {
  console.error(`\x1b[31m${m}\x1b[0m`);
  process.exit(1);
}

const sepolia = new JsonRpcProvider(RPC);
const base = new JsonRpcProvider(BASE_RPC);

async function hasCode(provider, addr, label) {
  if (!addr) return bad(`${label}: not configured`);
  let a;
  try {
    a = getAddress(addr.toLowerCase());
  } catch {
    return bad(`${label}: '${addr}' is not an address`);
  }
  const code = await provider.getCode(a);
  if (code === "0x") bad(`${label} ${a} — NO CODE on this chain (calls would return 0x)`);
  else ok(`${label} ${a} — ${code.length / 2 - 1} bytes`);
}

// ------------------------------------------------------- 1. chains reachable
console.log("\n\x1b[1m1 · Networks\x1b[0m");
for (const [name, p, want] of [
  ["Ethereum Sepolia", sepolia, POOL_CHAIN],
  ["Base Sepolia", base, BASE_CHAIN],
]) {
  try {
    const n = await p.getNetwork();
    if (Number(n.chainId) === want) ok(`${name} reachable, chainId ${n.chainId}`);
    else bad(`${name}: RPC reports chainId ${n.chainId}, expected ${want}`);
  } catch (e) {
    bad(`${name}: unreachable — ${e.shortMessage ?? e.message}`);
  }
}

// ------------------------------------------------- 2. our contracts exist
console.log("\n\x1b[1m2 · Our contracts\x1b[0m");
await hasCode(sepolia, env.NEXT_PUBLIC_MEGAPOT, "MegaPot        ");
await hasCode(sepolia, env.NEXT_PUBLIC_CUSDC, "ConfidentialUSDC");
await hasCode(sepolia, env.NEXT_PUBLIC_USDC, "USDC           ");
await hasCode(sepolia, env.NEXT_PUBLIC_PRIZE_INBOX, "PrizeInbox     ");
await hasCode(base, env.NEXT_PUBLIC_TICKET_AGENT, "TicketAgent    ");
await hasCode(base, env.NEXT_PUBLIC_JACKPOT, "Megapot jackpot");

// --------------------------------- 3. the pool points where the app thinks
console.log("\n\x1b[1m3 · Wiring matches\x1b[0m");
try {
  const abi = ["function cToken() view returns (address)", "function asset() view returns (address)"];
  const { Contract } = await import("ethers");
  const pool = new Contract(env.NEXT_PUBLIC_MEGAPOT, abi, sepolia);
  const [cToken, asset] = [await pool.cToken(), await pool.asset()];
  cToken.toLowerCase() === env.NEXT_PUBLIC_CUSDC.toLowerCase()
    ? ok("pool.cToken() matches NEXT_PUBLIC_CUSDC")
    : bad(`pool.cToken() = ${cToken}, but env says ${env.NEXT_PUBLIC_CUSDC}`);
  asset.toLowerCase() === env.NEXT_PUBLIC_USDC.toLowerCase()
    ? ok("pool.asset() matches NEXT_PUBLIC_USDC")
    : bad(`pool.asset() = ${asset}, but env says ${env.NEXT_PUBLIC_USDC}`);
} catch (e) {
  bad(`could not read pool wiring — ${e.shortMessage ?? e.message}`);
}

// ------------------------------------- 4. Zama infra the SDK depends on
console.log("\n\x1b[1m4 · Zama infrastructure (as the SDK sees it)\x1b[0m");
let SDK;
try {
  SDK = await import("@zama-fhe/relayer-sdk/node");
  ok("relayer SDK module loads");
} catch (e) {
  bad(`relayer SDK will not load — ${e.message}`);
}

if (SDK) {
  const cfg = SDK.SepoliaConfig;
  await hasCode(sepolia, cfg.aclContractAddress, "ACL            ");
  await hasCode(sepolia, cfg.kmsContractAddress, "KMSVerifier    ");
  await hasCode(sepolia, cfg.inputVerifierContractAddress, "InputVerifier  ");

  // The gateway verifying contracts live on chain 10901 and MUST NOT be looked up on Sepolia.
  // If the SDK is ever handed a provider for the wrong chain, this is what returns 0x.
  const gw = await sepolia.getCode(cfg.verifyingContractAddressInputVerification);
  gw === "0x"
    ? ok("gateway verifier correctly absent from Sepolia (it lives on chain 10901)")
    : bad("gateway verifier unexpectedly has code on Sepolia");

  if (cfg.chainId !== POOL_CHAIN) bad(`SDK SepoliaConfig.chainId=${cfg.chainId} != app chain ${POOL_CHAIN}`);
  else ok(`SDK config chainId ${cfg.chainId} matches the app`);
}

// ------------------------------------- 5. the SDK actually works, for real
console.log("\n\x1b[1m5 · End-to-end: init, instance, encrypt\x1b[0m");
if (SDK) {
  try {
    // The /node entry has no initSDK — WASM bootstrapping is browser-only. The browser-side
    // hazards are guarded statically in section 6 instead.
    if (typeof SDK.initSDK === "function") {
      await SDK.initSDK();
      ok("initSDK() succeeded");
    } else {
      ok("initSDK() absent on the node entry, as expected (browser-only WASM bootstrap)");
    }

    const inst = await SDK.createInstance({ ...SDK.SepoliaConfig, network: RPC });
    ok("createInstance() against the pinned RPC");

    const input = inst.createEncryptedInput(
      getAddress(env.NEXT_PUBLIC_MEGAPOT.toLowerCase()),
      getAddress("0xcF1B8469f63d9b1e19065835d8B609722Dfb6B43".toLowerCase()),
    );
    input.add64(1_000_000n);
    const enc = await input.encrypt();
    enc?.handles?.length === 1 && enc.inputProof?.length > 0
      ? ok(`encrypt() produced a handle (${enc.handles[0].length}b) + proof (${enc.inputProof.length}b)`)
      : bad("encrypt() returned nothing usable");
  } catch (e) {
    bad(`SDK end-to-end failed — ${e.shortMessage ?? e.message}`);
  }
}

// --------------------------- 6. source guards for the browser-only hazards
//
// These cannot be reached from Node — they only bite in a bundled browser build — so assert the
// shape of our own source instead. Each one maps to a bug that actually shipped.
console.log("\n\x1b[1m6 · Source guards\x1b[0m");
{
  const zama = readFileSync(join(here, "..", "lib", "zama.ts"), "utf8");

  zama.includes("@zama-fhe/relayer-sdk/web")
    ? ok("imports the /web ESM build")
    : bad("does not import @zama-fhe/relayer-sdk/web");

  zama.includes("relayer-sdk/bundle")
    ? bad("imports /bundle — a CDN shim that reads window.relayerSDK and is undefined under a bundler")
    : ok("does not import /bundle");

  /initSDK\s*\(/.test(zama) && !zama.includes("function ensureSdk")
    ? bad("calls initSDK() without a once-guard — a second call panics inside the WASM")
    : ok("initSDK() is behind a once-guard (ensureSdk)");

  zama.includes("network: RPC_URL")
    ? ok("SDK chain reads are pinned to an RPC, not the wallet's current network")
    : bad("SDK network is not pinned — a wallet on the wrong chain makes eip712Domain() return 0x");

  zama.includes("instancePromise = null")
    ? ok("a failed init is not cached (retryable)")
    : bad("a rejected init would be cached forever, poisoning the tab");
}


// ---------------------------------------------- 6 · the deployment answers our ABI
console.log("\n\x1b[1m7 · The deployed pool answers our ABI\x1b[0m");
{
  // The class of bug this catches is the one that actually happened: the ABI and the contract
  // source were perfectly consistent with each other, and the *deployment* was behind both. No
  // amount of type-checking sees that — only asking the chain does.
  // Read the artifact rather than the generated .ts — same ABI, and Node need not parse
  // TypeScript. `npm run abi:check` is what keeps the generated file honest against it.
  const abi = JSON.parse(
    readFileSync(join(here, "..", "..", "artifacts/contracts/MegaPot.sol/MegaPot.json"), "utf8"),
  ).abi;

  const code = await sepolia.getCode(env.NEXT_PUBLIC_MEGAPOT);
  const fns = abi.filter((e) => e.type === "function");
  const missing = [];

  for (const fn of fns) {
    const sig = `${fn.name}(${(fn.inputs ?? []).map(typeOf).join(",")})`;
    const selector = id(sig).slice(2, 10);
    if (!code.includes(selector)) missing.push(sig);
  }

  missing.length === 0
    ? ok(`all ${fns.length} ABI functions have a selector in the deployed bytecode`)
    : bad(
        `${missing.length} of ${fns.length} ABI functions are absent from the deployed contract — ` +
          `the deployment is behind the source. First few: ${missing.slice(0, 4).join(", ")}`,
      );
}

/** Canonical type string for a selector, expanding tuples. */
function typeOf(input) {
  if (!input.type.startsWith("tuple")) return input.type;
  const inner = input.components.map(typeOf).join(",");
  return input.type.replace("tuple", `(${inner})`);
}

// ---------------------------------------------------------------- verdict
console.log(
  failures === 0
    ? "\n\x1b[32m\x1b[1mPreflight passed.\x1b[0m The app can reach everything it is configured against.\n"
    : `\n\x1b[31m\x1b[1mPreflight failed: ${failures} problem(s).\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
