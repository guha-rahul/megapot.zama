import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";

import { MAIN, MEGA, USDC, decryptAs, encrypt64, publicDecrypt64 } from "./helpers";

const { ethers, fhevm } = hre;

const DAY = 24 * 60 * 60;
const OPERATOR_FOREVER = 2 ** 48 - 1;

/**
 * The claims a lottery has to actually make good on: odds really are proportional to stake, a
 * round always has at most one winner, and no round ever creates or destroys value.
 *
 * These run many full rounds against the mock coprocessor, so they are slower than the unit
 * suite — but they are the ones that would catch a broken ticket space.
 */
describe("MegaPot — fairness", function () {
  const ROUNDS = 30;

  async function deploy() {
    const [deployer, keeper, alice, bob, carol] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const cUSDC = await (
      await ethers.getContractFactory("ConfidentialUSDC")
    ).deploy(await usdc.getAddress(), "Confidential USDC", "cUSDC", "");
    const pot = await (
      await ethers.getContractFactory("MegaPot")
    ).deploy(await cUSDC.getAddress(), deployer.address, keeper.address);
    const vault = await (await ethers.getContractFactory("MockYieldVault")).deploy(await usdc.getAddress());
    const source = await (
      await ethers.getContractFactory("ERC4626YieldSource")
    ).deploy(await vault.getAddress(), await pot.getAddress());
    await pot.setYieldSource(await source.getAddress());

    const potAddr = await pot.getAddress();
    for (const user of [alice, bob, carol]) {
      await usdc.mint(user.address, USDC(100_000));
      await usdc.connect(user).approve(await cUSDC.getAddress(), USDC(100_000));
      await cUSDC.connect(user).wrap(user.address, USDC(100_000));
      await cUSDC.connect(user).setOperator(potAddr, OPERATOR_FOREVER);
    }

    return { deployer, keeper, alice, bob, carol, usdc, cUSDC, pot, vault, source, potAddr };
  }

  type Ctx = Awaited<ReturnType<typeof deploy>>;

  async function deposit(ctx: Ctx, user: Ctx["alice"], amount: bigint) {
    const enc = await encrypt64(ctx.potAddr, user, amount);
    await ctx.pot.connect(user).deposit(enc.handles[0], enc.inputProof);
  }

  async function balanceOf(ctx: Ctx, user: Ctx["alice"]) {
    return decryptAs(await ctx.pot.confidentialBalanceOf(user.address), ctx.potAddr, user);
  }

  /** Decrypt sequentially — the mock coprocessor walks its event log in order. */
  async function balances(ctx: Ctx, players: Ctx["alice"][]) {
    const out: bigint[] = [];
    for (const p of players) out.push(await balanceOf(ctx, p));
    return out;
  }

  /** Run one complete round and return each player's balance delta. */
  async function runRound(ctx: Ctx, players: Ctx["alice"][], yieldAmount: bigint) {
    const before = await balances(ctx, players);

    const roundId = Number(await ctx.pot.roundsLength(MAIN));
    await ctx.pot.connect(ctx.keeper).startRound(MAIN, (await time.latest()) + 10);
    await ctx.pot.connect(ctx.keeper).closeEntries(MAIN, roundId);
    const snapshot = (await ctx.pot.getRound(MAIN, roundId)).cursorSnapshot;
    const entries = await publicDecrypt64(snapshot);
    await ctx.pot.finalizeEntries(MAIN, roundId, entries.value, entries.proof);

    await ctx.usdc.mint(await ctx.vault.getAddress(), yieldAmount);
    await ctx.pot.harvest();
    const prize = await ctx.pot.prizeReserve();

    await time.increase(20);
    await ctx.pot.connect(ctx.keeper).draw(MAIN, roundId, DAY);
    for (const p of players) await ctx.pot.connect(p).claim(MAIN, roundId);

    const after = await balances(ctx, players);
    return { prize, deltas: after.map((v, i) => v - before[i]), totalTickets: entries.value };
  }

  it("wins in proportion to stake, and never more than one winner per round", async function () {
    const ctx = await deploy();

    // Alice holds 90% of the tickets, Bob 10%.
    await deposit(ctx, ctx.alice, USDC(9_000));
    await deposit(ctx, ctx.bob, USDC(1_000));

    // Move the principal into the yield venue once; every round harvests fresh yield from it.
    const tx = await ctx.pot.connect(ctx.keeper).requestDeploy();
    const receipt = await tx.wait();
    const id = ctx.pot.interface.parseLog(
      receipt!.logs.find((l) => l.address === ctx.potAddr && l.topics[0] === ctx.pot.interface.getEvent("DeployRequested")!.topicHash)!,
    )!.args.unwrapRequestId;
    const unwrapped = await publicDecrypt64(id);
    await ctx.cUSDC.finalizeUnwrap(id, unwrapped.value, unwrapped.proof);
    await ctx.pot.connect(ctx.keeper).invest();

    const players = [ctx.alice, ctx.bob];
    let aliceWins = 0;
    let bobWins = 0;

    for (let i = 0; i < ROUNDS; i++) {
      const { prize, deltas } = await runRound(ctx, players, USDC(10));

      const winners = deltas.filter((d) => d > 0n);
      expect(winners.length).to.be.lessThanOrEqual(1, `round ${i}: more than one winner`);
      expect(deltas.reduce((a, b) => a + b, 0n)).to.equal(prize, `round ${i}: value not conserved`);

      if (deltas[0] > 0n) aliceWins++;
      if (deltas[1] > 0n) bobWins++;
    }

    expect(aliceWins + bobWins).to.equal(ROUNDS, "every round found its owner (no dead tickets here)");
    // With a 90/10 split over 30 rounds, seeing Alice win fewer than 20 has probability ~1e-5.
    expect(aliceWins).to.be.greaterThanOrEqual(20, `alice ${aliceWins} / bob ${bobWins} — odds look wrong`);
    expect(aliceWins).to.be.lessThan(ROUNDS + 1);
  });

  it("never pays a depositor who holds no tickets", async function () {
    const ctx = await deploy();
    await deposit(ctx, ctx.alice, USDC(5_000));
    await deposit(ctx, ctx.bob, USDC(5_000));

    const tx = await ctx.pot.connect(ctx.keeper).requestDeploy();
    const receipt = await tx.wait();
    const id = ctx.pot.interface.parseLog(
      receipt!.logs.find((l) => l.address === ctx.potAddr && l.topics[0] === ctx.pot.interface.getEvent("DeployRequested")!.topicHash)!,
    )!.args.unwrapRequestId;
    const unwrapped = await publicDecrypt64(id);
    await ctx.cUSDC.finalizeUnwrap(id, unwrapped.value, unwrapped.proof);
    await ctx.pot.connect(ctx.keeper).invest();

    // Carol wraps cUSDC but never deposits into the pool.
    const players = [ctx.alice, ctx.bob, ctx.carol];

    for (let i = 0; i < 10; i++) {
      const { deltas } = await runRound(ctx, players, USDC(10));
      expect(deltas[2]).to.equal(0n, `round ${i}: a non-depositor was paid`);
    }
  });
});
