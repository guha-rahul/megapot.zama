import { expect } from "chai";
import hre from "hardhat";

import { USDC, expectCustomError } from "./helpers";

const { ethers } = hre;

/**
 * Wiring the pool to the wrong token.
 *
 * The bounty spec asks for sensible handling of unsupported tokens, and the honest answer for a
 * pool with one immutable token pair is to refuse at construction rather than pretend to support
 * a choice it does not have. These tests pin the boundary: what the pool accepts, what it refuses,
 * and — the part that matters — that refusing is recoverable rather than terminal.
 */
describe("MegaPot — token and venue configuration", function () {
  async function fixture() {
    const [deployer, keeper] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const cUSDC = await (
      await ethers.getContractFactory("ConfidentialUSDC")
    ).deploy(await usdc.getAddress(), "Confidential USDC", "cUSDC", "");
    const pot = await (
      await ethers.getContractFactory("MegaPot")
    ).deploy(await cUSDC.getAddress(), deployer.address, keeper.address);

    return { deployer, keeper, usdc, cUSDC, pot };
  }

  describe("the deposit token", function () {
    it("accepts a six-decimal underlying, where both unit scales agree", async function () {
      const { cUSDC, pot, usdc } = await fixture();

      // rate() == 1 is the whole invariant: one wrapper unit is one underlying unit, so the
      // pool's public accounting and its confidential ledger are denominated the same way.
      expect(await cUSDC.rate()).to.equal(1n);
      expect(await pot.asset()).to.equal(await usdc.getAddress());
    });

    it("refuses an eighteen-decimal underlying, whose wrapper rate would mix the two scales", async function () {
      const { deployer, keeper } = await fixture();

      const dai = await (
        await ethers.getContractFactory("MockToken")
      ).deploy("Dai Stablecoin", "DAI", 18);
      const cDai = await (
        await ethers.getContractFactory("ConfidentialUSDC")
      ).deploy(await dai.getAddress(), "Confidential DAI", "cDAI", "");

      // 10^(18-6). Every wrap would truncate, and deployedPrincipal would count something
      // different from prizeReserve.
      expect(await cDai.rate()).to.equal(10n ** 12n);

      await expectCustomError(
        async () =>
          (await ethers.getContractFactory("MegaPot")).deploy(
            await cDai.getAddress(),
            deployer.address,
            keeper.address,
          ),
        "UnsupportedToken()",
      );
    });

    it("refuses a zero token rather than deploying a pool with no asset", async function () {
      const { deployer, keeper } = await fixture();

      await expectCustomError(
        async () =>
          (await ethers.getContractFactory("MegaPot")).deploy(ethers.ZeroAddress, deployer.address, keeper.address),
        "UnsupportedToken()",
      );
    });
  });

  describe("the yield venue", function () {
    async function vaultFor(asset: string) {
      return (await ethers.getContractFactory("MockYieldVault")).deploy(asset);
    }

    it("refuses an adapter whose vault holds a different asset", async function () {
      const { usdc, pot } = await fixture();

      const other = await (await ethers.getContractFactory("MockToken")).deploy("Other", "OTH", 6);
      const wrongVault = await vaultFor(await other.getAddress());

      // Caught at the adapter's own constructor, so a mismatched venue can never be deployed
      // looking legitimate.
      await expectCustomError(
        async () =>
          (await ethers.getContractFactory("ERC4626YieldSource")).deploy(
            await wrongVault.getAddress(),
            await pot.getAddress(),
            await usdc.getAddress(),
          ),
        "AssetMismatch()",
      );
    });

    it("refuses to wire a source denominated in something other than the pool's asset", async function () {
      const { usdc, pot } = await fixture();

      // Build a self-consistent but wrong-asset source: it passes its own check, so the pool's
      // check is the one doing the work here.
      const other = await (await ethers.getContractFactory("MockToken")).deploy("Other", "OTH", 6);
      const wrongVault = await vaultFor(await other.getAddress());
      const wrongSource = await (
        await ethers.getContractFactory("ERC4626YieldSource")
      ).deploy(await wrongVault.getAddress(), await pot.getAddress(), await other.getAddress());

      await expectCustomError(
        async () => pot.setYieldSource(await wrongSource.getAddress()),
        "AssetMismatch()",
      );
      expect(await pot.yieldSource()).to.equal(ethers.ZeroAddress);
      expect(usdc).to.not.equal(other);
    });

    it("lets a venue be re-pointed while no principal is deployed", async function () {
      const { usdc, pot } = await fixture();
      const usdcAddr = await usdc.getAddress();

      const first = await (
        await ethers.getContractFactory("ERC4626YieldSource")
      ).deploy(await (await vaultFor(usdcAddr)).getAddress(), await pot.getAddress(), usdcAddr);
      const second = await (
        await ethers.getContractFactory("ERC4626YieldSource")
      ).deploy(await (await vaultFor(usdcAddr)).getAddress(), await pot.getAddress(), usdcAddr);

      await pot.setYieldSource(await first.getAddress());
      // Nothing is invested, so swapping venues moves nobody's money — a misconfiguration must be
      // recoverable, not terminal.
      await pot.setYieldSource(await second.getAddress());

      expect(await pot.yieldSource()).to.equal(await second.getAddress());
      expect(await pot.deployedPrincipal()).to.equal(0n);
    });
  });

  describe("funding", function () {
    it("credits the prize reserve with what arrived", async function () {
      const { deployer, usdc, pot } = await fixture();

      await usdc.mint(deployer.address, USDC(100));
      await usdc.approve(await pot.getAddress(), USDC(100));
      await pot.fundPrize(0, USDC(100));

      expect(await pot.prizeReserve()).to.equal(USDC(100));
    });

    it("refuses a zero-amount funding rather than emitting a meaningless event", async function () {
      const { pot } = await fixture();
      await expectCustomError(async () => pot.fundPrize(0, 0), "ZeroAmountFunded()");
      await expectCustomError(async () => pot.fundTicketBudget(0), "ZeroAmountFunded()");
    });
  });
});
