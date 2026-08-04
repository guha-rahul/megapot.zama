import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";

import { USDC, decryptAs, encrypt64, eventArg, publicDecrypt64 } from "./helpers";

const { ethers, fhevm } = hre;

const DAY = 24 * 60 * 60;
const OPERATOR_FOREVER = 2 ** 48 - 1;

describe("MegaPot — confidential no-loss lottery", function () {
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
    const cAddr = await cUSDC.getAddress();

    // Give every depositor 10,000 USDC, wrapped into confidential cUSDC, and let the pool move it.
    for (const user of [alice, bob, carol]) {
      await usdc.mint(user.address, USDC(10_000));
      await usdc.connect(user).approve(cAddr, USDC(10_000));
      await cUSDC.connect(user).wrap(user.address, USDC(10_000));
      await cUSDC.connect(user).setOperator(potAddr, OPERATOR_FOREVER);
    }

    return { deployer, keeper, alice, bob, carol, usdc, cUSDC, pot, vault, source, potAddr, cAddr };
  }

  type Ctx = Awaited<ReturnType<typeof deploy>>;

  async function deposit(ctx: Ctx, user: Ctx["alice"], amount: bigint) {
    const enc = await encrypt64(ctx.potAddr, user, amount);
    return ctx.pot.connect(user).deposit(enc.handles[0], enc.inputProof);
  }

  async function withdraw(ctx: Ctx, user: Ctx["alice"], amount: bigint) {
    const enc = await encrypt64(ctx.potAddr, user, amount);
    return ctx.pot.connect(user).withdraw(enc.handles[0], enc.inputProof);
  }

  async function balanceOf(ctx: Ctx, user: Ctx["alice"]) {
    return decryptAs(await ctx.pot.confidentialBalanceOf(user.address), ctx.potAddr, user);
  }

  /** Close entries for a round and submit the publicly decrypted cursor with its KMS proof. */
  async function settleEntries(ctx: Ctx, roundId: number) {
    await ctx.pot.connect(ctx.keeper).closeEntries(roundId);
    const round = await ctx.pot.getRound(roundId);
    const { value, proof } = await publicDecrypt64(round.cursorSnapshot);
    await ctx.pot.finalizeEntries(roundId, value, proof);
    return value;
  }

  /** Move pending deposits out to the yield source: unwrap the batch aggregate, then invest. */
  async function deployToYield(ctx: Ctx) {
    const tx = await ctx.pot.connect(ctx.keeper).requestDeploy();
    const id = await eventArg(ctx.pot, tx, "DeployRequested", "unwrapRequestId");
    const { value, proof } = await publicDecrypt64(id);
    await ctx.cUSDC.finalizeUnwrap(id, value, proof);
    await ctx.pot.connect(ctx.keeper).invest();
    return value;
  }

  /**
   * Simulate the yield venue earning `amount` and harvest it into the prize reserve. Returns the
   * prize that was actually realised — ERC-4626 rounds share conversions down, so a venue that
   * earned exactly `amount` can hand back a unit less. Tests assert against the realised figure.
   */
  async function accrueAndHarvest(ctx: Ctx, amount: bigint): Promise<bigint> {
    const before = await ctx.pot.prizeReserve();
    await ctx.usdc.mint(await ctx.vault.getAddress(), amount);
    await ctx.pot.harvest();
    return (await ctx.pot.prizeReserve()) - before;
  }

  // ------------------------------------------------------------------- //
  //                             Deposits                                //
  // ------------------------------------------------------------------- //

  describe("deposits", function () {
    it("credits an encrypted balance and an equally sized ticket range", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));

      expect(await balanceOf(ctx, ctx.alice)).to.equal(USDC(1_000));

      const ranges = await ctx.pot.rangesOf(ctx.alice.address);
      expect(ranges.length).to.equal(1);
      const lower = await decryptAs(ranges[0].lower, ctx.potAddr, ctx.alice);
      const upper = await decryptAs(ranges[0].upper, ctx.potAddr, ctx.alice);
      expect(lower).to.equal(0n);
      expect(upper - lower).to.equal(USDC(1_000));
    });

    it("stacks ranges without gaps or overlaps across depositors", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await deposit(ctx, ctx.bob, USDC(3_000));
      await deposit(ctx, ctx.alice, USDC(500));

      const a = await ctx.pot.rangesOf(ctx.alice.address);
      const b = await ctx.pot.rangesOf(ctx.bob.address);

      expect(await decryptAs(a[0].lower, ctx.potAddr, ctx.alice)).to.equal(0n);
      expect(await decryptAs(a[0].upper, ctx.potAddr, ctx.alice)).to.equal(USDC(1_000));
      expect(await decryptAs(b[0].lower, ctx.potAddr, ctx.bob)).to.equal(USDC(1_000));
      expect(await decryptAs(b[0].upper, ctx.potAddr, ctx.bob)).to.equal(USDC(4_000));
      expect(await decryptAs(a[1].lower, ctx.potAddr, ctx.alice)).to.equal(USDC(4_000));
      expect(await decryptAs(a[1].upper, ctx.potAddr, ctx.alice)).to.equal(USDC(4_500));

      expect(await balanceOf(ctx, ctx.alice)).to.equal(USDC(1_500));
    });

    it("only moves what the depositor actually holds", async function () {
      const ctx = await deploy();
      // Alice holds 10,000 cUSDC and asks to deposit 25,000.
      await deposit(ctx, ctx.alice, USDC(25_000));
      expect(await balanceOf(ctx, ctx.alice)).to.equal(0n);
    });

    it("compacts into a single range once MAX_RANGES is reached", async function () {
      const ctx = await deploy();
      const max = Number(await ctx.pot.MAX_RANGES());
      for (let i = 0; i < max; i++) await deposit(ctx, ctx.alice, USDC(100));
      expect(await ctx.pot.rangeCountOf(ctx.alice.address)).to.equal(max);

      await deposit(ctx, ctx.alice, USDC(100));
      expect(await ctx.pot.rangeCountOf(ctx.alice.address)).to.equal(1);

      const ranges = await ctx.pot.rangesOf(ctx.alice.address);
      const span =
        (await decryptAs(ranges[0].upper, ctx.potAddr, ctx.alice)) -
        (await decryptAs(ranges[0].lower, ctx.potAddr, ctx.alice));
      expect(span).to.equal(USDC(100 * (max + 1)));
      expect(await balanceOf(ctx, ctx.alice)).to.equal(USDC(100 * (max + 1)));
    });
  });

  // ------------------------------------------------------------------- //
  //                         Confidentiality                             //
  // ------------------------------------------------------------------- //

  describe("confidentiality", function () {
    it("hides balances and odds from everyone but their owner", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));

      const handle = await ctx.pot.confidentialBalanceOf(ctx.alice.address);
      await expect(decryptAs(handle, ctx.potAddr, ctx.bob)).to.be.rejected;

      const ranges = await ctx.pot.rangesOf(ctx.alice.address);
      await expect(decryptAs(ranges[0].upper, ctx.potAddr, ctx.bob)).to.be.rejected;
    });

    it("keeps the winning ticket encrypted", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await settleEntries(ctx, await startRound(ctx));
      await deployToYield(ctx);
      await accrueAndHarvest(ctx, USDC(50));
      await time.increase(DAY);
      await ctx.pot.connect(ctx.keeper).draw(0, DAY);

      const round = await ctx.pot.getRound(0);
      // Nobody — not even a depositor — is allowed to read the draw.
      await expect(decryptAs(round.ticket, ctx.potAddr, ctx.alice)).to.be.rejected;
    });
  });

  async function startRound(ctx: Ctx) {
    const drawTime = (await time.latest()) + DAY;
    const tx = await ctx.pot.connect(ctx.keeper).startRound(drawTime);
    await tx.wait();
    return Number(await ctx.pot.roundsLength()) - 1;
  }

  // ------------------------------------------------------------------- //
  //                        Entries / batching                           //
  // ------------------------------------------------------------------- //

  describe("round entries", function () {
    it("reveals only the aggregate cursor, never an individual deposit", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_234));
      await deposit(ctx, ctx.bob, USDC(4_321));
      await deposit(ctx, ctx.carol, USDC(2_000));

      const roundId = await startRound(ctx);
      const total = await settleEntries(ctx, roundId);

      expect(total).to.equal(USDC(7_555));
      expect((await ctx.pot.getRound(roundId)).totalTickets).to.equal(USDC(7_555));
      expect(await ctx.pot.settledTickets()).to.equal(USDC(7_555));
    });

    it("tags deposits made after the close for the next round", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      const round0 = await startRound(ctx);
      await settleEntries(ctx, round0);

      await deposit(ctx, ctx.bob, USDC(1_000));
      const bobRanges = await ctx.pot.rangesOf(ctx.bob.address);
      expect(bobRanges[0].round).to.equal(1);
      // Round 0's modulus was frozen before Bob arrived.
      expect((await ctx.pot.getRound(round0)).totalTickets).to.equal(USDC(1_000));
    });
  });

  // ------------------------------------------------------------------- //
  //                          Yield → prize                              //
  // ------------------------------------------------------------------- //

  describe("yield", function () {
    it("deploys the batch aggregate into the yield source and harvests only surplus", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await deposit(ctx, ctx.bob, USDC(3_000));

      const deployed = await deployToYield(ctx);
      expect(deployed).to.equal(USDC(4_000));
      expect(await ctx.pot.deployedPrincipal()).to.equal(USDC(4_000));
      expect(await ctx.source.totalAssets()).to.equal(USDC(4_000));

      await expect(ctx.pot.harvest()).to.be.revertedWithCustomError(ctx.pot, "NoYield");

      const prize = await accrueAndHarvest(ctx, USDC(200));
      expect(prize <= USDC(200) && prize >= USDC(200) - 2n).to.equal(true, "surplus harvested (mod 4626 rounding)");
      expect(await ctx.pot.prizeReserve()).to.equal(prize);
      // Principal is untouched — this is what makes the lottery no-loss.
      expect(await ctx.pot.deployedPrincipal()).to.equal(USDC(4_000));
      expect(await ctx.source.totalAssets()).to.equal(USDC(4_000));
    });

    it("keeps principal accounted for when the venue can only partially fill", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await deployToYield(ctx);

      // The venue goes illiquid and can only return 400 of the 1,000 asked for.
      await ctx.vault.setWithdrawCap(USDC(400));
      await ctx.pot.connect(ctx.keeper).refillBuffer(USDC(1_000));

      // The 600 still stuck in the venue is principal, not yield. Crediting the full request here
      // would let the next harvest pay it out as a prize — spending depositors' principal.
      expect(await ctx.pot.deployedPrincipal()).to.equal(USDC(600));
      expect(await ctx.source.totalAssets()).to.equal(USDC(600));
      await expect(ctx.pot.harvest()).to.be.revertedWithCustomError(ctx.pot, "NoYield");

      // Once the venue frees up, the rest comes back and real yield harvests normally.
      await ctx.vault.setWithdrawCap(ethers.MaxUint256);
      await ctx.pot.connect(ctx.keeper).refillBuffer(USDC(600));
      expect(await ctx.pot.deployedPrincipal()).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------- //
  //                              Draws                                  //
  // ------------------------------------------------------------------- //

  describe("draws", function () {
    it("awards the whole prize to exactly one depositor, invisibly", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await deposit(ctx, ctx.bob, USDC(1_000));
      await deposit(ctx, ctx.carol, USDC(1_000));

      const roundId = await startRound(ctx);
      await settleEntries(ctx, roundId);
      await deployToYield(ctx);
      const prize = await accrueAndHarvest(ctx, USDC(300));

      await time.increase(DAY);
      await ctx.pot.connect(ctx.keeper).draw(roundId, DAY);
      expect((await ctx.pot.getRound(roundId)).prize).to.equal(prize);
      expect(await ctx.pot.prizeReserve()).to.equal(0n);

      for (const user of [ctx.alice, ctx.bob, ctx.carol]) {
        await ctx.pot.connect(user).claim(roundId);
      }

      const balances = [
        await balanceOf(ctx, ctx.alice),
        await balanceOf(ctx, ctx.bob),
        await balanceOf(ctx, ctx.carol),
      ];

      // Conservation: 3,000 principal + the prize, all of the prize to exactly one depositor.
      expect(balances.reduce((a, b) => a + b, 0n)).to.equal(USDC(3_000) + prize);
      expect(balances.filter((b) => b === USDC(1_000) + prize).length).to.equal(1);
      expect(balances.filter((b) => b === USDC(1_000)).length).to.equal(2);
    });

    it("pays the sole depositor when they own every ticket", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(2_000));
      const roundId = await startRound(ctx);
      await settleEntries(ctx, roundId);
      await deployToYield(ctx);
      const prize = await accrueAndHarvest(ctx, USDC(75));

      await time.increase(DAY);
      await ctx.pot.connect(ctx.keeper).draw(roundId, DAY);
      await ctx.pot.connect(ctx.alice).claim(roundId);

      expect(await balanceOf(ctx, ctx.alice)).to.equal(USDC(2_000) + prize);
    });

    it("cannot be claimed twice", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      const roundId = await startRound(ctx);
      await settleEntries(ctx, roundId);
      await deployToYield(ctx);
      const prize = await accrueAndHarvest(ctx, USDC(10));
      await time.increase(DAY);
      await ctx.pot.connect(ctx.keeper).draw(roundId, DAY);

      await ctx.pot.connect(ctx.alice).claim(roundId);
      await expect(ctx.pot.connect(ctx.alice).claim(roundId)).to.be.revertedWithCustomError(ctx.pot, "AlreadyClaimed");
      expect(await balanceOf(ctx, ctx.alice)).to.equal(USDC(1_000) + prize);
    });

    it("never pays more than the prize even if latecomers claim", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      const roundId = await startRound(ctx);
      await settleEntries(ctx, roundId);
      await deployToYield(ctx);
      const prize = await accrueAndHarvest(ctx, USDC(40));
      await time.increase(DAY);
      await ctx.pot.connect(ctx.keeper).draw(roundId, DAY);

      // Alice owns every ticket in round 0, so she wins. Bob joins afterwards and claims too;
      // his range is tagged for round 1 and must be ignored.
      await deposit(ctx, ctx.bob, USDC(1_000));
      await ctx.pot.connect(ctx.alice).claim(roundId);
      await ctx.pot.connect(ctx.bob).claim(roundId);

      expect(await balanceOf(ctx, ctx.alice)).to.equal(USDC(1_000) + prize);
      expect(await balanceOf(ctx, ctx.bob)).to.equal(USDC(1_000));
    });

    it("rejects a draw before its time, and from a stranger", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      const roundId = await startRound(ctx);
      await settleEntries(ctx, roundId);
      await deployToYield(ctx);
      await accrueAndHarvest(ctx, USDC(10));

      await expect(ctx.pot.connect(ctx.keeper).draw(roundId, DAY)).to.be.revertedWithCustomError(ctx.pot, "TooEarly");
      await time.increase(DAY);
      await expect(ctx.pot.connect(ctx.alice).draw(roundId, DAY)).to.be.revertedWithCustomError(ctx.pot, "OnlyKeeper");
    });
  });

  // ------------------------------------------------------------------- //
  //                        Rollovers / sweeps                           //
  // ------------------------------------------------------------------- //

  describe("rollovers", function () {
    it("rolls an unclaimed prize into the next round's reserve", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      const roundId = await startRound(ctx);
      await settleEntries(ctx, roundId);
      await deployToYield(ctx);
      const prize = await accrueAndHarvest(ctx, USDC(60));
      await time.increase(DAY);
      await ctx.pot.connect(ctx.keeper).draw(roundId, DAY);

      // Nobody claims.
      await time.increase(DAY + 1);
      await ctx.pot.requestSweep(roundId);
      const round = await ctx.pot.getRound(roundId);
      const { value, proof } = await publicDecrypt64(round.unclaimed);
      expect(value).to.equal(prize);

      await ctx.pot.finalizeSweep(roundId, value, proof);
      expect(await ctx.pot.prizeReserve()).to.equal(prize);
      expect((await ctx.pot.getRound(roundId)).state).to.equal(6); // Settled
    });

    it("reports nothing left to roll over when the prize was won", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      const roundId = await startRound(ctx);
      await settleEntries(ctx, roundId);
      await deployToYield(ctx);
      await accrueAndHarvest(ctx, USDC(60));
      await time.increase(DAY);
      await ctx.pot.connect(ctx.keeper).draw(roundId, DAY);
      await ctx.pot.connect(ctx.alice).claim(roundId);

      await time.increase(DAY + 1);
      await ctx.pot.requestSweep(roundId);
      const { value } = await publicDecrypt64((await ctx.pot.getRound(roundId)).unclaimed);
      expect(value).to.equal(0n);
    });

    it("runs back-to-back rounds", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await deposit(ctx, ctx.bob, USDC(1_000));

      const r0 = await startRound(ctx);
      await settleEntries(ctx, r0);
      await deployToYield(ctx);
      const prize0 = await accrueAndHarvest(ctx, USDC(100));
      await time.increase(DAY);
      await ctx.pot.connect(ctx.keeper).draw(r0, DAY);
      await ctx.pot.connect(ctx.alice).claim(r0);
      await ctx.pot.connect(ctx.bob).claim(r0);

      const r1 = await startRound(ctx);
      expect(r1).to.equal(1);
      await deposit(ctx, ctx.carol, USDC(2_000));
      await settleEntries(ctx, r1);
      expect((await ctx.pot.getRound(r1)).totalTickets).to.equal(USDC(4_000));

      await deployToYield(ctx);
      const prize1 = await accrueAndHarvest(ctx, USDC(80));
      await time.increase(DAY);
      await ctx.pot.connect(ctx.keeper).draw(r1, DAY);

      for (const user of [ctx.alice, ctx.bob, ctx.carol]) await ctx.pot.connect(user).claim(r1);

      const total =
        (await balanceOf(ctx, ctx.alice)) + (await balanceOf(ctx, ctx.bob)) + (await balanceOf(ctx, ctx.carol));
      expect(total).to.equal(USDC(4_000) + prize0 + prize1);
    });
  });

  // ------------------------------------------------------------------- //
  //                           Withdrawals                               //
  // ------------------------------------------------------------------- //

  describe("withdrawals", function () {
    it("pays out confidentially from the buffer and shrinks the ticket range", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));

      const before = await decryptAs(await ctx.cUSDC.confidentialBalanceOf(ctx.alice.address), ctx.cAddr, ctx.alice);
      await withdraw(ctx, ctx.alice, USDC(400));
      const after = await decryptAs(await ctx.cUSDC.confidentialBalanceOf(ctx.alice.address), ctx.cAddr, ctx.alice);

      expect(after - before).to.equal(USDC(400));
      expect(await balanceOf(ctx, ctx.alice)).to.equal(USDC(600));

      const ranges = await ctx.pot.rangesOf(ctx.alice.address);
      const span =
        (await decryptAs(ranges[0].upper, ctx.potAddr, ctx.alice)) -
        (await decryptAs(ranges[0].lower, ctx.potAddr, ctx.alice));
      expect(span).to.equal(USDC(600));
      expect(await decryptAs(await ctx.pot.lastWithdrawnOf(ctx.alice.address), ctx.potAddr, ctx.alice)).to.equal(
        USDC(400),
      );
    });

    it("shrinks across several ranges, newest first", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(500));
      await deposit(ctx, ctx.bob, USDC(1_000)); // separates Alice's two ranges
      await deposit(ctx, ctx.alice, USDC(300));

      await withdraw(ctx, ctx.alice, USDC(600));

      const ranges = await ctx.pot.rangesOf(ctx.alice.address);
      const span = async (i: number) =>
        (await decryptAs(ranges[i].upper, ctx.potAddr, ctx.alice)) -
        (await decryptAs(ranges[i].lower, ctx.potAddr, ctx.alice));

      // The newest range (300) is emptied first, then 300 more comes off the older one.
      expect(await span(1)).to.equal(0n);
      expect(await span(0)).to.equal(USDC(200));
      expect(await balanceOf(ctx, ctx.alice)).to.equal(USDC(200));
    });

    it("caps a withdrawal at the depositor's balance", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await withdraw(ctx, ctx.alice, USDC(9_999));
      expect(await balanceOf(ctx, ctx.alice)).to.equal(0n);
      expect(await decryptAs(await ctx.pot.lastWithdrawnOf(ctx.alice.address), ctx.potAddr, ctx.alice)).to.equal(
        USDC(1_000),
      );
    });

    it("pays nothing and takes nothing when the buffer is empty", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await deployToYield(ctx); // every cUSDC unwrapped and sent to the yield source

      await withdraw(ctx, ctx.alice, USDC(400));
      expect(await balanceOf(ctx, ctx.alice)).to.equal(USDC(1_000), "balance untouched");
      expect(await decryptAs(await ctx.pot.lastWithdrawnOf(ctx.alice.address), ctx.potAddr, ctx.alice)).to.equal(0n);

      // The keeper refills the buffer and the retry goes through.
      await ctx.pot.connect(ctx.keeper).refillBuffer(USDC(500));
      await withdraw(ctx, ctx.alice, USDC(400));
      expect(await balanceOf(ctx, ctx.alice)).to.equal(USDC(600));
    });

    it("rate-limits re-staking to once per round", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));

      expect(await ctx.pot.canCompact(ctx.alice.address)).to.equal(true);
      await ctx.pot.connect(ctx.alice).restake();
      expect(await ctx.pot.canCompact(ctx.alice.address)).to.equal(false);

      // Without this cap, re-staking in a loop would inflate the ticket space with dead tickets
      // until nearly every draw rolled over — a cheap way to stall the whole pool.
      await expect(ctx.pot.connect(ctx.alice).restake()).to.be.revertedWithCustomError(
        ctx.pot,
        "AlreadyCompactedThisRound",
      );

      // The next round resets it.
      const roundId = await startRound(ctx);
      await settleEntries(ctx, roundId);
      expect(await ctx.pot.canCompact(ctx.alice.address)).to.equal(true);
      await ctx.pot.connect(ctx.alice).restake();
    });

    it("lets a depositor re-stake winnings into fresh tickets", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      const roundId = await startRound(ctx);
      await settleEntries(ctx, roundId);
      await deployToYield(ctx);
      const prize = await accrueAndHarvest(ctx, USDC(120));
      await time.increase(DAY);
      await ctx.pot.connect(ctx.keeper).draw(roundId, DAY);
      await ctx.pot.connect(ctx.alice).claim(roundId);

      await ctx.pot.connect(ctx.alice).restake();
      const ranges = await ctx.pot.rangesOf(ctx.alice.address);
      expect(ranges.length).to.equal(1);
      const span =
        (await decryptAs(ranges[0].upper, ctx.potAddr, ctx.alice)) -
        (await decryptAs(ranges[0].lower, ctx.potAddr, ctx.alice));
      expect(span).to.equal(USDC(1_000) + prize, "winnings now count toward the odds");
    });
  });

  // ------------------------------------------------------------------- //
  //                          Access control                             //
  // ------------------------------------------------------------------- //

  describe("access control", function () {
    it("restricts keeper-only operations", async function () {
      const ctx = await deploy();
      await expect(ctx.pot.connect(ctx.alice).startRound(1)).to.be.revertedWithCustomError(ctx.pot, "OnlyKeeper");
      await expect(ctx.pot.connect(ctx.alice).closeEntries(0)).to.be.revertedWithCustomError(ctx.pot, "OnlyKeeper");
      await expect(ctx.pot.connect(ctx.alice).requestDeploy()).to.be.revertedWithCustomError(ctx.pot, "OnlyKeeper");
      await expect(ctx.pot.connect(ctx.alice).refillBuffer(1)).to.be.revertedWithCustomError(ctx.pot, "OnlyKeeper");
    });

    it("honours the deposit pause", async function () {
      const ctx = await deploy();
      await ctx.pot.connect(ctx.keeper).setDepositsPaused(true);
      const enc = await encrypt64(ctx.potAddr, ctx.alice, USDC(100));
      await expect(
        ctx.pot.connect(ctx.alice).deposit(enc.handles[0], enc.inputProof),
      ).to.be.revertedWithCustomError(ctx.pot, "DepositsPaused");
    });

    it("unwinds every position on an emergency", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await deployToYield(ctx);
      expect(await ctx.pot.deployedPrincipal()).to.equal(USDC(1_000));

      await ctx.pot.emergencyUnwind();
      expect(await ctx.pot.deployedPrincipal()).to.equal(0n);
      expect(await ctx.pot.depositsPaused()).to.equal(true);

      // Principal is back in the confidential buffer and fully withdrawable.
      await withdraw(ctx, ctx.alice, USDC(1_000));
      expect(await balanceOf(ctx, ctx.alice)).to.equal(0n);
    });
  });
});
