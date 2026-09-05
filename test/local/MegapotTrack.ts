import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";

import { MAIN, MEGA, USDC, decryptAs, encrypt64, expectCustomError, publicDecrypt64 } from "./helpers";

const { ethers } = hre;

const DAY = 24 * 60 * 60;
const OPERATOR_FOREVER = 2 ** 48 - 1;

/**
 * The opt-in second prize.
 *
 * `MEGA` is a whole second game — its own cursor, rounds and reserve — layered over the same
 * encrypted balance ledger. What these tests pin down is that it is genuinely *additive*: opting
 * in cannot shrink your main-track odds, cannot touch your principal, and cannot be used to
 * inflate either ticket space by toggling.
 */
describe("MegaPot — the opt-in Megapot track", function () {
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
    ).deploy(await vault.getAddress(), await pot.getAddress(), await usdc.getAddress());

    await pot.setYieldSource(await source.getAddress());

    const potAddr = await pot.getAddress();
    const cAddr = await cUSDC.getAddress();

    for (const user of [alice, bob, carol]) {
      await usdc.mint(user.address, USDC(10_000));
      await usdc.connect(user).approve(cAddr, USDC(10_000));
      await cUSDC.connect(user).wrap(user.address, USDC(10_000));
      await cUSDC.connect(user).setOperator(potAddr, OPERATOR_FOREVER);
    }
    await usdc.mint(deployer.address, USDC(10_000));

    return { deployer, keeper, alice, bob, carol, usdc, cUSDC, pot, vault, source, potAddr, cAddr };
  }

  type Ctx = Awaited<ReturnType<typeof deploy>>;

  const deposit = async (ctx: Ctx, user: Ctx["alice"], amount: bigint) => {
    const enc = await encrypt64(ctx.potAddr, user, amount);
    return ctx.pot.connect(user).deposit(enc.handles[0], enc.inputProof);
  };

  const withdraw = async (ctx: Ctx, user: Ctx["alice"], amount: bigint) => {
    const enc = await encrypt64(ctx.potAddr, user, amount);
    return ctx.pot.connect(user).withdraw(enc.handles[0], enc.inputProof);
  };

  /** A depositor's total live tickets on a track, decrypted as them. */
  async function ticketsOf(ctx: Ctx, track: number, user: Ctx["alice"]) {
    const ranges = await ctx.pot.rangesOf(track, user.address);
    let total = 0n;
    for (const r of ranges) {
      total +=
        (await decryptAs(r.upper, ctx.potAddr, user)) - (await decryptAs(r.lower, ctx.potAddr, user));
    }
    return total;
  }

  async function startRound(ctx: Ctx, track: number) {
    const drawTime = (await time.latest()) + DAY;
    await ctx.pot.connect(ctx.keeper).startRound(track, drawTime);
    return Number(await ctx.pot.roundsLength(track)) - 1;
  }

  async function settleEntries(ctx: Ctx, track: number, roundId: number) {
    await ctx.pot.connect(ctx.keeper).closeEntries(track, roundId);
    const round = await ctx.pot.getRound(track, roundId);
    const { value, proof } = await publicDecrypt64(round.cursorSnapshot);
    await ctx.pot.finalizeEntries(track, roundId, value, proof);
    return value;
  }

  /** Fund a track's prize directly, the way `PrizeInbox.flush` funds `MEGA`. */
  async function fundPrize(ctx: Ctx, track: number, amount: bigint) {
    await ctx.usdc.connect(ctx.deployer).approve(ctx.potAddr, amount);
    await ctx.pot.connect(ctx.deployer).fundPrize(track, amount);
  }

  // ------------------------------------------------------------------- //
  //                            Opting in                                //
  // ------------------------------------------------------------------- //

  describe("opting in", function () {
    it("mints Megapot tickets covering the existing balance, leaving the main track alone", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));

      expect(await ticketsOf(ctx, MEGA, ctx.alice)).to.equal(0n);

      await ctx.pot.connect(ctx.alice).setMegapotAllocation(10_000);

      expect(await ctx.pot.playsMegapot(ctx.alice.address)).to.equal(true);
      expect(await ticketsOf(ctx, MEGA, ctx.alice)).to.equal(USDC(1_000));
      // The whole point: joining the second game does not cost you anything in the first.
      expect(await ticketsOf(ctx, MAIN, ctx.alice)).to.equal(USDC(1_000));
    });

    it("mirrors later deposits onto both tracks", async function () {
      const ctx = await deploy();
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(10_000);
      await deposit(ctx, ctx.alice, USDC(400));
      await deposit(ctx, ctx.alice, USDC(600));

      expect(await ticketsOf(ctx, MAIN, ctx.alice)).to.equal(USDC(1_000));
      expect(await ticketsOf(ctx, MEGA, ctx.alice)).to.equal(USDC(1_000));
    });

    it("leaves a depositor who never opted in with no Megapot tickets", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.bob, USDC(5_000));

      expect(await ctx.pot.playsMegapot(ctx.bob.address)).to.equal(false);
      expect(await ticketsOf(ctx, MEGA, ctx.bob)).to.equal(0n);
      expect(await ticketsOf(ctx, MAIN, ctx.bob)).to.equal(USDC(5_000));
    });

    it("refuses an allocation that is out of range, off-step, or the one already set", async function () {
      const ctx = await deploy();
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(2_500);

      // Above 100%.
      await expectCustomError(
        () => ctx.pot.connect(ctx.bob).setMegapotAllocation.staticCall(10_001),
        "InvalidAllocation()",
      );
      // Off-step. Coarse buckets are what keep a public preference from becoming a fingerprint,
      // so an arbitrary 3,700 is refused rather than silently rounded.
      await expectCustomError(
        () => ctx.pot.connect(ctx.bob).setMegapotAllocation.staticCall(3_750),
        "InvalidAllocation()",
      );
      // A no-op write, which would burn a rate-limit slot and emit a misleading event.
      await expectCustomError(
        () => ctx.pot.connect(ctx.alice).setMegapotAllocation.staticCall(2_500),
        "InvalidAllocation()",
      );
      await expectCustomError(
        () => ctx.pot.connect(ctx.bob).setMegapotAllocation.staticCall(0),
        "InvalidAllocation()",
      );
    });
  });

  // ------------------------------------------------------------------- //
  //                        Partial allocation                           //
  // ------------------------------------------------------------------- //

  describe("choosing a share", function () {
    it("mints tickets in proportion to the chosen share, not the whole balance", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));

      await ctx.pot.connect(ctx.alice).setMegapotAllocation(2_500);

      expect(await ticketsOf(ctx, MEGA, ctx.alice)).to.equal(USDC(250));
      // Additive, at every setting: a quarter in the second game costs nothing in the first.
      expect(await ticketsOf(ctx, MAIN, ctx.alice)).to.equal(USDC(1_000));
    });

    it("mirrors later deposits at the chosen share", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(2_500);

      await deposit(ctx, ctx.alice, USDC(400));
      await deposit(ctx, ctx.alice, USDC(600));

      expect(await ticketsOf(ctx, MAIN, ctx.alice)).to.equal(USDC(2_000));
      expect(await ticketsOf(ctx, MEGA, ctx.alice)).to.equal(USDC(500));
    });

    it("re-stakes at the current share rather than silently promoting to the whole balance", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(2_500);

      // `_compact` used to mint `_balance[user]` on whichever track it was given, which would
      // have quietly turned this depositor's 25% into 100% the moment they re-staked.
      await settleEntries(ctx, MAIN, await startRound(ctx, MAIN));
      await settleEntries(ctx, MEGA, await startRound(ctx, MEGA));
      await ctx.pot.connect(ctx.alice).restake();

      expect(await ticketsOf(ctx, MAIN, ctx.alice)).to.equal(USDC(1_000));
      expect(await ticketsOf(ctx, MEGA, ctx.alice)).to.equal(USDC(250));
    });

    it("shrinks both tracks proportionally on a withdrawal", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(4_000);

      await withdraw(ctx, ctx.alice, USDC(500));

      // Releasing the full amount from MEGA would have destroyed 500 of the 400 tickets held —
      // five times the correct release, clamped at zero and therefore invisible.
      expect(await ticketsOf(ctx, MAIN, ctx.alice)).to.equal(USDC(500));
      expect(await ticketsOf(ctx, MEGA, ctx.alice)).to.equal(USDC(200));
    });

    it("tops a raise up by the shortfall, leaving the ranges already held intact", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(2_500);

      const before = await ctx.pot.rangesOf(MEGA, ctx.alice.address);

      await settleEntries(ctx, MEGA, await startRound(ctx, MEGA));
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(5_000);

      const after = await ctx.pot.rangesOf(MEGA, ctx.alice.address);
      expect(await ticketsOf(ctx, MEGA, ctx.alice)).to.equal(USDC(500));
      // A raise mints only the difference, so it creates no dead tickets at all.
      expect(after.length).to.equal(2);
      expect(after[0].lower).to.equal(before[0].lower);
      expect(after[0].upper).to.equal(before[0].upper);
    });

    it("lets a depositor lower repeatedly without waiting for a new round", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(10_000);

      // Leaving, wholly or partly, is never rate-limited — only minting can inflate the space,
      // and charging someone to leave would trap them in a game they no longer want.
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(5_000);
      expect(await ticketsOf(ctx, MEGA, ctx.alice)).to.equal(USDC(500));

      await ctx.pot.connect(ctx.alice).setMegapotAllocation(1_000);
      expect(await ticketsOf(ctx, MEGA, ctx.alice)).to.equal(USDC(100));

      expect(await ticketsOf(ctx, MAIN, ctx.alice)).to.equal(USDC(1_000));
    });
  });

  // ------------------------------------------------------------------- //
  //                           Opting out                                //
  // ------------------------------------------------------------------- //

  describe("opting out", function () {
    it("drops Megapot tickets but never touches the main position or the balance", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(10_000);
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(0);

      expect(await ctx.pot.playsMegapot(ctx.alice.address)).to.equal(false);
      expect(await ticketsOf(ctx, MEGA, ctx.alice)).to.equal(0n);
      expect(await ticketsOf(ctx, MAIN, ctx.alice)).to.equal(USDC(1_000));
      expect(await decryptAs(await ctx.pot.confidentialBalanceOf(ctx.alice.address), ctx.potAddr, ctx.alice)).to.equal(
        USDC(1_000),
      );
    });

    it("rate-limits toggling, so the ticket space cannot be inflated for free", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));

      await ctx.pot.connect(ctx.alice).setMegapotAllocation(10_000);
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(0);
      // Opting back in within the same entry round would mint a second live range over the same
      // balance while the first one's positions are already dead — that is the inflation attack.
      await expectCustomError(
        () => ctx.pot.connect(ctx.alice).setMegapotAllocation.staticCall(10_000),
        "AlreadyCompactedThisRound()",
      );
    });

    it("lets a depositor rejoin once the entry round has moved on", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(10_000);
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(0);

      const roundId = await startRound(ctx, MEGA);
      await settleEntries(ctx, MEGA, roundId);

      await ctx.pot.connect(ctx.alice).setMegapotAllocation(10_000);
      expect(await ticketsOf(ctx, MEGA, ctx.alice)).to.equal(USDC(1_000));
    });
  });

  // ------------------------------------------------------------------- //
  //                       Withdrawing while opted in                    //
  // ------------------------------------------------------------------- //

  it("shrinks both tracks by exactly the amount withdrawn", async function () {
    const ctx = await deploy();
    await deposit(ctx, ctx.alice, USDC(1_000));
    await ctx.pot.connect(ctx.alice).setMegapotAllocation(10_000);

    await withdraw(ctx, ctx.alice, USDC(400));

    expect(await ticketsOf(ctx, MAIN, ctx.alice)).to.equal(USDC(600));
    expect(await ticketsOf(ctx, MEGA, ctx.alice)).to.equal(USDC(600));
  });

  // ------------------------------------------------------------------- //
  //                  Settling claims before tickets move                //
  // ------------------------------------------------------------------- //

  /**
   * Reshaping a ticket range decides, retroactively, whether a prize was won.
   *
   * Withdrawing, re-staking and changing an allocation all move ranges, and a win is decided by
   * whether the encrypted ticket falls inside one. Doing that before settling would destroy a
   * prize the depositor had already won — and destroy it *invisibly*, because everything here is
   * encrypted: they would simply see an award of zero and read it as an ordinary loss.
   *
   * Every one of these fails on a contract that reshapes first.
   */
  describe("claims settle before ranges move", function () {
    /** Draw a round Alice is certain to win, by making her the only holder of the space. */
    async function soleWinner(ctx: Ctx, track: number, prize: bigint) {
      const roundId = await startRound(ctx, track);
      await settleEntries(ctx, track, roundId);
      await fundPrize(ctx, track, prize);
      await time.increase(DAY);
      await ctx.pot.connect(ctx.keeper).draw(track, roundId, DAY);
      return roundId;
    }

    it("pays a pending win into the balance a withdrawal is capped against", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      const roundId = await soleWinner(ctx, MAIN, USDC(50));

      // Withdraw everything without claiming first. The old order shrank the winning range and
      // silently binned the prize.
      await withdraw(ctx, ctx.alice, USDC(1_050));

      expect(await ctx.pot.hasClaimed(MAIN, roundId, ctx.alice.address)).to.equal(true);
      expect(await decryptAs(await ctx.pot.awardOf(MAIN, roundId, ctx.alice.address), ctx.potAddr, ctx.alice)).to.equal(
        USDC(50),
      );
      // Principal and prize both left the pool, so "withdraw everything" means everything.
      expect(await decryptAs(await ctx.pot.confidentialBalanceOf(ctx.alice.address), ctx.potAddr, ctx.alice)).to.equal(
        0n,
      );
    });

    it("folds a pending win into the new range when re-staking", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await soleWinner(ctx, MAIN, USDC(50));

      await settleEntries(ctx, MAIN, await startRound(ctx, MAIN));
      await ctx.pot.connect(ctx.alice).restake();

      // The win is in the balance, so the fresh range covers it too.
      expect(await ticketsOf(ctx, MAIN, ctx.alice)).to.equal(USDC(1_050));
    });

    it("pays a pending Megapot win before an allocation change drops the range", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(10_000);
      const roundId = await soleWinner(ctx, MEGA, USDC(25));

      // Dropping to zero deletes every MEGA range — including the one that just won.
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(0);

      expect(await decryptAs(await ctx.pot.awardOf(MEGA, roundId, ctx.alice.address), ctx.potAddr, ctx.alice)).to.equal(
        USDC(25),
      );
    });

    it("stays idempotent when the depositor already claimed by hand", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      const roundId = await soleWinner(ctx, MAIN, USDC(50));

      await ctx.pot.connect(ctx.alice).claim(MAIN, roundId);
      // Must not revert AlreadyClaimed on the auto-settle path.
      await withdraw(ctx, ctx.alice, USDC(100));

      // 1,000 deposited + 50 won − 100 withdrawn. Tickets track the deposit, not the winnings:
      // a prize lands in the balance and only becomes tickets when the depositor re-stakes.
      expect(await decryptAs(await ctx.pot.confidentialBalanceOf(ctx.alice.address), ctx.potAddr, ctx.alice)).to.equal(
        USDC(950),
      );
      expect(await ticketsOf(ctx, MAIN, ctx.alice)).to.equal(USDC(900));
    });
  });

  // ------------------------------------------------------------------- //
  //                         Drawing the track                           //
  // ------------------------------------------------------------------- //

  describe("draws", function () {
    it("pays an opted-in depositor and cannot pay one who opted out", async function () {
      const ctx = await deploy();
      // Alice plays both games; Bob only the main one. Alice therefore owns every MEGA ticket.
      await deposit(ctx, ctx.alice, USDC(1_000));
      await deposit(ctx, ctx.bob, USDC(9_000));
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(10_000);

      const roundId = await startRound(ctx, MEGA);
      const total = await settleEntries(ctx, MEGA, roundId);
      expect(total).to.equal(USDC(1_000)); // Bob contributes nothing to this space

      await fundPrize(ctx, MEGA, USDC(50));
      await time.increase(DAY);
      await ctx.pot.connect(ctx.keeper).draw(MEGA, roundId, DAY);

      const before = await decryptAs(
        await ctx.pot.confidentialBalanceOf(ctx.alice.address),
        ctx.potAddr,
        ctx.alice,
      );
      await ctx.pot.connect(ctx.alice).claim(MEGA, roundId);
      const after = await decryptAs(
        await ctx.pot.confidentialBalanceOf(ctx.alice.address),
        ctx.potAddr,
        ctx.alice,
      );
      expect(after - before).to.equal(USDC(50));

      // Bob may call claim — it is indistinguishable from any other claim — but holds no MEGA
      // tickets, so it awards him nothing.
      const bobBefore = await decryptAs(
        await ctx.pot.confidentialBalanceOf(ctx.bob.address),
        ctx.potAddr,
        ctx.bob,
      );
      await ctx.pot.connect(ctx.bob).claim(MEGA, roundId);
      const bobAfter = await decryptAs(
        await ctx.pot.confidentialBalanceOf(ctx.bob.address),
        ctx.potAddr,
        ctx.bob,
      );
      expect(bobAfter).to.equal(bobBefore);
    });

    it("runs the two tracks independently — separate rounds, reserves and ticket totals", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await deposit(ctx, ctx.bob, USDC(3_000));
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(10_000);

      await fundPrize(ctx, MAIN, USDC(10));
      await fundPrize(ctx, MEGA, USDC(70));

      const [, mainSettled, mainReserve] = await ctx.pot.trackInfo(MAIN);
      const [, megaSettled, megaReserve] = await ctx.pot.trackInfo(MEGA);
      expect(mainReserve).to.equal(USDC(10));
      expect(megaReserve).to.equal(USDC(70));
      expect(mainSettled).to.equal(0n); // nothing settled yet on either
      expect(megaSettled).to.equal(0n);

      const mainRound = await startRound(ctx, MAIN);
      const megaRound = await startRound(ctx, MEGA);
      expect(await settleEntries(ctx, MAIN, mainRound)).to.equal(USDC(4_000));
      expect(await settleEntries(ctx, MEGA, megaRound)).to.equal(USDC(1_000));
    });
  });

  // ------------------------------------------------------------------- //
  //                      The award handle (EIP-712)                     //
  // ------------------------------------------------------------------- //

  it("hands every claimer an award handle only they can read", async function () {
    const ctx = await deploy();
    await deposit(ctx, ctx.alice, USDC(1_000));
    await ctx.pot.connect(ctx.alice).setMegapotAllocation(10_000);

    const roundId = await startRound(ctx, MEGA);
    await settleEntries(ctx, MEGA, roundId);
    await fundPrize(ctx, MEGA, USDC(25));
    await time.increase(DAY);
    await ctx.pot.connect(ctx.keeper).draw(MEGA, roundId, DAY);

    await ctx.pot.connect(ctx.alice).claim(MEGA, roundId);
    await ctx.pot.connect(ctx.bob).claim(MEGA, roundId);

    // Alice owns the whole space, so she won; Bob holds a handle that decrypts to zero. The point
    // is that both *have* a handle — its existence says nothing about the outcome.
    const aliceAward = await ctx.pot.awardOf(MEGA, roundId, ctx.alice.address);
    const bobAward = await ctx.pot.awardOf(MEGA, roundId, ctx.bob.address);

    expect(await decryptAs(aliceAward, ctx.potAddr, ctx.alice)).to.equal(USDC(25));
    expect(await decryptAs(bobAward, ctx.potAddr, ctx.bob)).to.equal(0n);
  });

  // ------------------------------------------------------------------- //
  //                          The yield split                            //
  // ------------------------------------------------------------------- //

  describe("yield split", function () {
    /** Push deposits out to the vault so `harvest` has principal to earn on. */
    async function deployToYield(ctx: Ctx) {
      const tx = await ctx.pot.connect(ctx.keeper).requestDeploy();
      const receipt = await tx.wait();
      const parsed = receipt!.logs
        .map((l) => {
          try {
            return ctx.pot.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l) => l?.name === "DeployRequested");
      const id = parsed!.args.unwrapRequestId;
      const { value, proof } = await publicDecrypt64(id);
      await ctx.cUSDC.finalizeUnwrap(id, value, proof);
      await ctx.pot.connect(ctx.keeper).invest();
    }

    /** Harvest, and report the surplus the venue actually returned. */
    async function harvested(ctx: Ctx): Promise<bigint> {
      const receipt = await (await ctx.pot.harvest()).wait();
      const log = receipt!.logs
        .map((l) => {
          try {
            return ctx.pot.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l) => l?.name === "Harvested");
      return log!.args.surplus as bigint;
    }

    /** Point the pool at a Megapot route so `harvest` will actually compute the split. */
    async function wireMegapotRoute(ctx: Ctx) {
      const agent = ethers.Wallet.createRandom().address;
      await ctx.pot.connect(ctx.deployer).setMegapotRoute(agent, 6, agent);
    }

    it("routes only the opted-in share of yield to Megapot tickets", async function () {
      const ctx = await deploy();
      // Alice (opted in) holds a quarter of the pool; Bob holds the rest.
      await deposit(ctx, ctx.alice, USDC(1_000));
      await deposit(ctx, ctx.bob, USDC(3_000));
      await ctx.pot.connect(ctx.alice).setMegapotAllocation(10_000);

      // Both spaces must be settled — the split reads the revealed ticket totals.
      const mainRound = await startRound(ctx, MAIN);
      await settleEntries(ctx, MAIN, mainRound);
      const megaRound = await startRound(ctx, MEGA);
      await settleEntries(ctx, MEGA, megaRound);

      // The split only runs when there is somewhere to spend the budget. There is no governance
      // percentage any more — each depositor's own allocation is the whole control.
      await wireMegapotRoute(ctx);
      await deployToYield(ctx);

      await ctx.usdc.mint(await ctx.vault.getAddress(), USDC(400));
      const realised = await harvested(ctx);

      // Alice is 1,000 of 4,000 tickets, so a quarter of the realised yield buys tickets and the
      // rest stays as the main prize. Bob never funds a prize he cannot win.
      //
      // Asserted against what the venue actually returned, not the nominal 400: ERC-4626 rounds
      // share conversions down, so a vault that earned exactly 400 hands back a unit less.
      expect(await ctx.pot.ticketBudget()).to.equal(realised / 4n);
      expect(await ctx.pot.prizeReserve()).to.equal(realised - realised / 4n);
    });

    it("sends everything to the main prize when nobody has opted in", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      const roundId = await startRound(ctx, MAIN);
      await settleEntries(ctx, MAIN, roundId);

      await wireMegapotRoute(ctx);
      await deployToYield(ctx);

      await ctx.usdc.mint(await ctx.vault.getAddress(), USDC(100));
      const realised = await harvested(ctx);

      expect(await ctx.pot.ticketBudget()).to.equal(0n);
      expect(await ctx.pot.prizeReserve()).to.equal(realised);
    });
  });

  // ------------------------------------------------------------------- //
  //                     Withdraw at any time (buffer)                   //
  // ------------------------------------------------------------------- //

  describe("permissionless buffer top-up", function () {
    it("lets anyone restore the buffer so a withdrawal settles at once", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));

      // Push everything out to the vault, leaving no buffer at all.
      const tx = await ctx.pot.connect(ctx.keeper).requestDeploy();
      const receipt = await tx.wait();
      const parsed = receipt!.logs
        .map((l) => {
          try {
            return ctx.pot.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l) => l?.name === "DeployRequested");
      const id = parsed!.args.unwrapRequestId;
      const { value, proof } = await publicDecrypt64(id);
      await ctx.cUSDC.finalizeUnwrap(id, value, proof);
      await ctx.pot.connect(ctx.keeper).invest();

      // With an empty buffer the withdrawal moves nothing — the pre-existing behaviour.
      await withdraw(ctx, ctx.alice, USDC(400));
      expect(await decryptAs(await ctx.pot.lastWithdrawnOf(ctx.alice.address), ctx.potAddr, ctx.alice)).to.equal(0n);

      // Carol has no position and no role, and can still repair it.
      await ctx.pot.connect(ctx.deployer).setBufferTarget(USDC(500));
      await ctx.pot.connect(ctx.carol).topUpBuffer();

      const [buffered, target] = await ctx.pot.bufferStatus();
      expect(target).to.equal(USDC(500));
      expect(buffered).to.equal(0n); // it was wrapped into cUSDC, so it left the raw balance

      await withdraw(ctx, ctx.alice, USDC(400));
      expect(await decryptAs(await ctx.pot.lastWithdrawnOf(ctx.alice.address), ctx.potAddr, ctx.alice)).to.equal(
        USDC(400),
      );
    });

    it("refuses to pull when the buffer already meets its target", async function () {
      const ctx = await deploy();
      await deposit(ctx, ctx.alice, USDC(1_000));
      await ctx.pot.connect(ctx.deployer).setBufferTarget(0);

      await expectCustomError(() => ctx.pot.connect(ctx.carol).topUpBuffer.staticCall(), "BufferFull()");
    });
  });
});
