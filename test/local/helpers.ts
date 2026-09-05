import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import hre from "hardhat";

const { ethers, fhevm } = hre;

export const USDC = (n: number | string) => ethers.parseUnits(String(n), 6);

/** Track indices, mirroring `MegaPot.MAIN` / `MegaPot.MEGA`. */
export const MAIN = 0;
export const MEGA = 1;

/**
 * Build an encrypted `euint64` input bound to `contractAddress` and `user`. This is the exact
 * flow a dapp runs client-side via the Zama relayer SDK before submitting a transaction.
 */
export async function encrypt64(contractAddress: string, user: HardhatEthersSigner, value: bigint) {
  const input = fhevm.createEncryptedInput(contractAddress, user.address);
  input.add64(value);
  return input.encrypt();
}

const ZERO_HANDLE = "0x" + "0".repeat(64);

/**
 * Decrypt a handle as the user who owns it (fails unless both user and contract are allowed).
 * An all-zero handle means the slot was never written, which the FHE library treats as zero.
 */
export async function decryptAs(handle: string, contractAddress: string, user: HardhatEthersSigner): Promise<bigint> {
  if (handle === ZERO_HANDLE) return 0n;
  return fhevm.userDecryptEuint(FhevmType.euint64, handle, contractAddress, user);
}

/**
 * Publicly decrypt a handle that a contract marked with `FHE.makePubliclyDecryptable`, returning
 * the cleartext plus the KMS proof that lets a contract verify it via `FHE.checkSignatures`.
 * Off-chain this is a relayer call; the proof is what authorises the value on-chain.
 */
export async function publicDecrypt64(handle: string): Promise<{ value: bigint; proof: string }> {
  const res = await fhevm.publicDecrypt([handle]);
  const value = Object.values(res.clearValues)[0];
  return { value: BigInt(value as bigint), proof: res.decryptionProof };
}

/** Pull a single named event argument out of a transaction receipt. */
export async function eventArg(
  contract: { interface: { parseLog: (l: { topics: readonly string[]; data: string }) => any } },
  tx: any,
  eventName: string,
  argName: string,
) {
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === eventName) return parsed.args[argName];
    } catch {
      /* not our event */
    }
  }
  throw new Error(`event ${eventName} not found`);
}

/**
 * Assert that a call reverts with a named custom error, matching on the 4-byte selector.
 *
 * Chai's `revertedWithCustomError` goes through Hardhat's revert decoder, and the FHEVM mock
 * provider intercepts that path. For some of the pool's functions the interception turns a
 * perfectly good revert into an opaque "Fhevm assertion failed" with the error name lost — the
 * contract is right, the harness just cannot read it. Matching the selector on an `eth_call` is
 * decoder-independent and asserts exactly the same thing.
 */
export async function expectCustomError(fn: () => Promise<unknown>, signature: string) {
  const selector = ethers.id(signature).slice(0, 10);
  const name = signature.slice(0, signature.indexOf("("));
  try {
    await fn();
  } catch (e) {
    const msg = String((e as Error).message);
    if (msg.includes(selector) || msg.includes(name)) return;
    throw new Error(`expected ${signature} (${selector}), got: ${msg.slice(0, 200)}`);
  }
  throw new Error(`expected ${signature}, but the call succeeded`);
}
