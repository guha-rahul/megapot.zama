import { FhevmType } from "@fhevm/hardhat-plugin";
import { task, types } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

import { assertZamaSupported } from "./addresses";
import { readDeployment } from "./deployments";

/**
 * Drives the confidential flow against a **live network** — real Circle USDC, the real Zama
 * coprocessor, and the real relayer/KMS. Same code path as the local suite, but nothing is
 * mocked: every encryption is done by the relayer and every public decryption carries a genuine
 * KMS signature that the contract verifies on-chain.
 *
 *   npx hardhat megapot:live-flow --network sepolia
 *
 * A round-trip through the relayer takes seconds rather than milliseconds, so this logs each
 * step as it goes.
 */

const step = (n: number, msg: string) => console.log(`\n[${n}] ${msg}`);
const usd = (v: bigint | number) => `${Number(v) / 1e6}`;

async function fhevm(hre: HardhatRuntimeEnvironment) {
  await hre.fhevm.initializeCLIApi();
  return hre.fhevm;
}

async function encrypt(hre: HardhatRuntimeEnvironment, contract: string, user: string, amount: bigint) {
  const input = (await fhevm(hre)).createEncryptedInput(contract, user);
  input.add64(amount);
  return input.encrypt();
}

async function decryptMine(hre: HardhatRuntimeEnvironment, handle: string, contract: string, signer: any) {
  if (handle === hre.ethers.ZeroHash) return 0n;
  return (await fhevm(hre)).userDecryptEuint(FhevmType.euint64, handle, contract, signer);
}

async function publicDecrypt(hre: HardhatRuntimeEnvironment, handle: string) {
  const res = await (await fhevm(hre)).publicDecrypt([handle]);
  return { value: BigInt(Object.values(res.clearValues)[0] as bigint), proof: res.decryptionProof };
}

/** The demo drives the main prize; the Megapot track has its own lifecycle. */
const MAIN = 0;

task("megapot:live-flow", "Run deposit → round → draw → claim against a live network")
  .addOptionalParam("amount", "USDC to deposit from the deployer", "5", types.string)
  .addOptionalParam("prize", "USDC to seed the prize with (stands in for yield on testnet)", "1", types.string)
  .addOptionalParam("claimWindow", "Claim window in seconds", 3600, types.int)
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    assertZamaSupported(chainId);

    const d = readDeployment(hre.network.name) as any;
    const [me] = await ethers.getSigners();
    const pot = await ethers.getContractAt("MegaPot", d.megaPot);
    const cUSDC = await ethers.getContractAt("ConfidentialUSDC", d.confidentialUSDC);
    const usdc = await ethers.getContractAt("IERC20", d.usdc);

    const amount = ethers.parseUnits(args.amount, 6);
    const prize = ethers.parseUnits(args.prize, 6);

    console.log(`network ${hre.network.name} (${chainId})   account ${me.address}`);
    console.log(`pool    ${d.megaPot}`);
    console.log(`USDC    ${d.usdc}`);

    const held = await usdc.balanceOf(me.address);
    console.log(`balance ${usd(held)} USDC`);
    if (held < amount + prize) {
      throw new Error(
        `need at least ${usd(amount + prize)} USDC. Get Sepolia USDC from https://faucet.circle.com`,
      );
    }

    // ---------------------------------------------------------------- 1
    step(1, "Wrapping USDC into confidential cUSDC");
    await (await usdc.approve(d.confidentialUSDC, amount)).wait();
    await (await cUSDC.wrap(me.address, amount)).wait();
    if (!(await cUSDC.isOperator(me.address, d.megaPot))) {
      await (await cUSDC.setOperator(d.megaPot, 2 ** 48 - 1)).wait();
    }
    console.log(`    wrapped ${usd(amount)} — the pool may now move it`);

    // ---------------------------------------------------------------- 2
    step(2, "Depositing an encrypted amount (relayer encrypts client-side)");
    const enc = await encrypt(hre, d.megaPot, me.address, amount);
    await (await pot.deposit(enc.handles[0], enc.inputProof)).wait();
    const balance = await decryptMine(hre, await pot.confidentialBalanceOf(me.address), d.megaPot, me);
    console.log(`    pool balance ${usd(balance)} — a ciphertext on-chain, readable only by you`);

    // ---------------------------------------------------------------- 3
    step(3, "Opening a round and closing entries");
    const roundId = Number(await pot.roundsLength(MAIN));
    const drawTime = Math.floor(Date.now() / 1000) + 30;
    await (await pot.startRound(MAIN, drawTime)).wait();
    await (await pot.closeEntries(MAIN, roundId)).wait();

    const snapshot = (await pot.getRound(MAIN, roundId)).cursorSnapshot;
    console.log(`    cursor handle ${snapshot}`);
    console.log("    asking the KMS to publicly decrypt the aggregate…");
    const entries = await publicDecrypt(hre, snapshot);
    await (await pot.finalizeEntries(MAIN, roundId, entries.value, entries.proof)).wait();
    console.log(`    ${usd(entries.value)} tickets in play (verified on-chain against a real KMS signature)`);

    // ---------------------------------------------------------------- 4
    step(4, "Funding the prize");
    // On testnet there is no ERC-4626 USDC venue to skim, so the prize is funded directly.
    // On mainnet this is what `harvest()` and the Megapot winnings round-trip do.
    await (await usdc.approve(d.megaPot, prize)).wait();
    await (await pot.fundPrize(MAIN, prize)).wait();
    console.log(`    prize reserve ${usd(await pot.prizeReserve())} USDC`);

    // ---------------------------------------------------------------- 5
    step(5, "Waiting for the draw time, then drawing");
    while (Math.floor(Date.now() / 1000) < drawTime) {
      await new Promise((r) => setTimeout(r, 5000));
      process.stdout.write(".");
    }
    await (await pot.draw(MAIN, roundId, args.claimWindow)).wait();
    const round = await pot.getRound(MAIN, roundId);
    console.log(`\n    round ${roundId} drawn — prize ${usd(round.prize)} over ${usd(round.totalTickets)} tickets`);
    console.log(`    winning ticket ${round.ticket} (encrypted; nobody can read it)`);

    // ---------------------------------------------------------------- 6
    step(6, "Claiming");
    const before = await decryptMine(hre, await pot.confidentialBalanceOf(me.address), d.megaPot, me);
    await (await pot.claim(MAIN, roundId)).wait();
    const after = await decryptMine(hre, await pot.confidentialBalanceOf(me.address), d.megaPot, me);

    console.log(
      after > before
        ? `    🎉 won ${usd(after - before)} USDC — visible only to you`
        : `    no win this round (balance still ${usd(after)})`,
    );
    console.log(
      `\nThe claim transaction looks identical either way. Anyone watching the chain sees a claim; ` +
        `only you can tell what it did.`,
    );
  });

task("megapot:live-check", "Verify a live deployment is wired correctly").setAction(async (_args, hre) => {
  const { ethers } = hre;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const d = readDeployment(hre.network.name) as any;

  const pot = await ethers.getContractAt("MegaPot", d.megaPot);
  const cUSDC = await ethers.getContractAt("ConfidentialUSDC", d.confidentialUSDC);

  console.log(`chain              ${chainId}`);
  console.log(`MegaPot            ${d.megaPot}`);
  console.log(`  asset            ${await pot.asset()}  (expected ${d.usdc})`);
  console.log(`  cToken           ${await pot.cToken()}`);
  console.log(`  keeper           ${await pot.keeper()}`);
  console.log(`  yieldSource      ${await pot.yieldSource()}`);
  console.log(`ConfidentialUSDC   ${d.confidentialUSDC}`);
  console.log(`  underlying       ${await cUSDC.underlying()}`);
  console.log(`  rate             ${await cUSDC.rate()}  (1 = same units)`);
  console.log(`PrizeInbox         ${d.prizeInbox}`);
  console.log(`Megapot route`);
  console.log(`  bridge           ${await pot.bridge()}`);
  console.log(`  domain           ${await pot.megapotDomain()}`);
  console.log(`  agent            ${await pot.ticketAgent()}`);
  console.log(`  megapot share    ${await pot.megapotShareBps()} bps of the next harvest`);

  // The Zama coprocessor has to actually be reachable, not just configured.
  await hre.fhevm.initializeCLIApi();
  console.log(`\nZama runtime       ${hre.fhevm.isMock ? "MOCK (local)" : "LIVE relayer"}`);
});
