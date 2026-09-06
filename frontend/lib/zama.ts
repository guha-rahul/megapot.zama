"use client";

import type { FhevmInstance } from "@zama-fhe/relayer-sdk/web";
import type { Address, WalletClient } from "viem";

/**
 * Client-side Zama Protocol plumbing: encrypt inputs before they go on-chain, and decrypt the
 * handles you are allowed to read. Both happen in the browser — the pool never sees a plaintext.
 */

const ZERO_HANDLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** The SDK reads chain state directly; keep that pinned to Sepolia regardless of wallet state. */
import { customRpc, isUsable } from "./rpc";

/**
 * The SDK reads chain config directly, so it needs the same endpoint the app is using — including
 * a viewer-supplied one, or its `eip712Domain()` call fails while the rest of the app works.
 *
 * Each candidate is validated rather than merely checked for existence. `??` is the wrong test
 * here: `.env.local` ships `NEXT_PUBLIC_RPC_URL=` as a documented "leave blank for the public
 * endpoint", Next inlines a blank as `""`, and `""` is neither null nor undefined — so nullish
 * coalescing selects it and the SDK rejects the empty string with "Invalid network URL". Every
 * page keeps working, because only this path needs the endpoint, so it presents as encryption
 * being broken rather than as configuration.
 */
const FALLBACK_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

function resolveRpc(): string {
  const candidates = [
    typeof window !== "undefined" ? customRpc() : undefined,
    process.env.NEXT_PUBLIC_RPC_URL,
  ];
  for (const url of candidates) {
    if (typeof url === "string" && url.length > 0 && isUsable(url)) return url;
  }
  return FALLBACK_RPC;
}

const RPC_URL = resolveRpc();

export const isZeroHandle = (handle: string) => !handle || handle === ZERO_HANDLE;

let instancePromise: Promise<FhevmInstance> | null = null;
let sdkReady: Promise<void> | null = null;

/**
 * Initialise the TFHE WASM exactly once.
 *
 * `initSDK()` is not idempotent — a second call panics inside the WASM with
 * "called `Result::unwrap_throw()` on an `Err` value". React StrictMode double-invokes effects in
 * development, so an unguarded call fails on the second render. Threaded init also needs
 * SharedArrayBuffer, which requires cross-origin isolation; fall back to a single thread rather
 * than dying where that is unavailable.
 */
function ensureSdk(mod: { initSDK: (opts?: { thread?: number }) => Promise<unknown> }): Promise<void> {
  if (!sdkReady) {
    sdkReady = mod
      .initSDK()
      .then(() => undefined)
      .catch(async () => {
        await mod.initSDK({ thread: 1 });
      });
  }
  return sdkReady;
}

/** Lazily boot the relayer SDK (it loads a multi-megabyte TFHE WASM bundle — do it once). */
export async function getFhevm(): Promise<FhevmInstance> {
  if (!instancePromise) {
    instancePromise = (async () => {
      // `/web` is the real ESM build. `/bundle` is a CDN shim whose entire body is
      // `export const initSDK = window.relayerSDK.initSDK` — it assumes a <script> tag has
      // already installed the UMD global, so under a bundler it throws
      // "Cannot read properties of undefined (reading 'initSDK')".
      const mod = await import("@zama-fhe/relayer-sdk/web");
      await ensureSdk(mod);

      // Pin the SDK's chain reads to an RPC rather than `window.ethereum`.
      //
      // The SDK builds an ethers BrowserProvider from whatever it is handed, so passing the wallet
      // makes every Zama contract lookup follow the wallet's *current* network. One tab left on
      // the wrong chain and `eip712Domain()` hits an address with no code, returning `0x` —
      // surfacing as "could not decode result data (value=0x, method=eip712Domain)".
      //
      // Nothing here needs to sign: encrypted inputs and user-decryption signatures are produced
      // through our own wallet client. So the instance only ever needs read access to Sepolia.
      return mod.createInstance({ ...mod.SepoliaConfig, network: RPC_URL });
    })().catch((e) => {
      // Do not cache a rejection: a transient relayer/RPC hiccup would otherwise poison every
      // later call for the lifetime of the tab.
      instancePromise = null;
      throw e;
    });
  }
  return instancePromise;
}

/**
 * Encrypt a `uint64` for one contract and one caller. The resulting handle is only usable by
 * `user` calling `contractAddress` — it cannot be replayed elsewhere.
 */
export async function encryptAmount(contractAddress: Address, user: Address, amount: bigint) {
  const fhevm = await getFhevm();
  const input = fhevm.createEncryptedInput(contractAddress, user);
  input.add64(amount);
  const { handles, inputProof } = await input.encrypt();
  return {
    handle: toHex(handles[0]) as `0x${string}`,
    proof: toHex(inputProof) as `0x${string}`,
  };
}

/**
 * A signed decryption session. Producing one costs a single wallet signature; it is then reused
 * for every handle the user reads until it expires, so the UI does not prompt on every refresh.
 */
export type DecryptSession = {
  privateKey: string;
  publicKey: string;
  signature: string;
  contractAddresses: Address[];
  userAddress: Address;
  startTimestamp: number;
  durationDays: number;
};

export async function createDecryptSession(
  walletClient: WalletClient,
  user: Address,
  contractAddresses: Address[],
  durationDays = 7,
): Promise<DecryptSession> {
  const fhevm = await getFhevm();
  const keypair = fhevm.generateKeypair();
  const startTimestamp = Math.floor(Date.now() / 1000);

  const eip712 = fhevm.createEIP712(keypair.publicKey, contractAddresses, startTimestamp, durationDays);

  // The SDK hands back a ready-made EIP-712 payload; viem's generics want a mutable shape, so the
  // whole request is cast once rather than field by field.
  const request = {
    account: user,
    domain: eip712.domain,
    types: { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification },
    primaryType: "UserDecryptRequestVerification",
    message: eip712.message,
  } as unknown as Parameters<WalletClient["signTypedData"]>[0];

  const signature = await walletClient.signTypedData(request);

  return {
    privateKey: keypair.privateKey,
    publicKey: keypair.publicKey,
    signature,
    contractAddresses,
    userAddress: user,
    startTimestamp,
    durationDays,
  };
}

/**
 * Decrypt handles the user has been granted access to. Zero handles are storage slots that were
 * never written, which the FHE library treats as zero — no round-trip needed.
 */
export async function userDecrypt(
  session: DecryptSession,
  pairs: { handle: string; contractAddress: Address }[],
): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  const real = pairs.filter((p) => !isZeroHandle(p.handle));
  for (const p of pairs) if (isZeroHandle(p.handle)) out[p.handle] = 0n;
  if (real.length === 0) return out;

  const fhevm = await getFhevm();
  const results = await fhevm.userDecrypt(
    real,
    session.privateKey,
    session.publicKey,
    session.signature,
    session.contractAddresses,
    session.userAddress,
    session.startTimestamp,
    session.durationDays,
  );

  for (const [handle, value] of Object.entries(results)) out[handle.toLowerCase()] = BigInt(value as bigint);
  for (const p of real) {
    const key = p.handle.toLowerCase();
    if (out[key] !== undefined) out[p.handle] = out[key];
  }
  return out;
}

function toHex(bytes: Uint8Array | string): string {
  if (typeof bytes === "string") return bytes.startsWith("0x") ? bytes : `0x${bytes}`;
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Publicly decrypt a handle a contract has marked `makePubliclyDecryptable`, returning the
 * cleartext together with the KMS proof that authorises it on-chain.
 *
 * Unlike a user decryption, the result is meant to become public: a threshold of KMS nodes signs
 * it, and `FHE.checkSignatures` verifies that signature rather than trusting the caller. Anyone
 * can therefore finalise one of these.
 */
export async function publicDecrypt(handle: string): Promise<{ value: bigint; proof: `0x${string}` }> {
  const fhevm = await getFhevm();
  const res = await fhevm.publicDecrypt([handle]);
  const value = Object.values(res.clearValues)[0];
  return { value: BigInt(value as bigint), proof: res.decryptionProof as `0x${string}` };
}
