import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

/**
 * The Megapot leg, exercised against the **live Base Sepolia deployment** — the real jackpot
 * proxy, the real token, real ticket purchases. No stand-ins.
 *
 *   npx hardhat --config hardhat.megapot.config.ts test test/MegapotAgent.fork.ts
 *
 * Run under their own config: `@fhevm/hardhat-plugin` refuses any chain but 31337, so keeping it
 * out is what makes forking the live deployment possible.
 */
const JACKPOT = "0x6f03c7BCaDAdBf5E6F5900DA3d56AdD8FbDac5De";
const MPUSDC = "0xA4253E7C13525287C56550b8708100f93E60509f";
const ONE = 1_000_000n; // the pay token is 6dp

const JACKPOT_ABI = [
  "function usersInfo(address) view returns (uint256 ticketsPurchasedTotalBps, uint256 winningsClaimable, bool active)",
  "function referralFeesClaimable(address) view returns (uint256)",
  "function ticketPrice() view returns (uint256)",
  "function token() view returns (address)",
  "function feeBps() view returns (uint256)",
  "function referralFeeBps() view returns (uint256)",
  "function allowPurchasing() view returns (bool)",
  "function jackpotLock() view returns (bool)",
  "function userPoolTotal() view returns (uint256)",
  "function ticketCountTotalBps() view returns (uint256)",
  "function lastJackpotEndTime() view returns (uint256)",
  "function roundDurationInSeconds() view returns (uint256)",
];

const TOKEN_ABI = [
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
];

describe("MegapotTicketAgent — live Base Sepolia Megapot", function () {
  before(async function () {
    const net = await ethers.provider.getNetwork();
    if (net.chainId !== 84532n) {
      console.log("      (skipped — run with --config hardhat.megapot.config.ts)");
      this.skip();
    }
  });

  async function deployAgent() {
    const [governance, keeper] = await ethers.getSigners();

    const jackpot = new ethers.Contract(JACKPOT, JACKPOT_ABI, ethers.provider);
    const token = new ethers.Contract(MPUSDC, TOKEN_ABI, ethers.provider);

    // No CCTP on this leg: Megapot's testnet token is TestTokenUSDC, which CCTP cannot carry.
    // The agent is built to run with bridging disabled for exactly this case.
    const agent = await (
      await ethers.getContractFactory("MegapotTicketAgent")
    ).deploy(
      JACKPOT,
      ethers.ZeroAddress,
      0, // home domain: Ethereum
      ethers.zeroPadValue(governance.address, 32),
      governance.address,
      keeper.address,
    );
    await agent.waitForDeployment();

    return { governance, keeper, jackpot, token, agent, agentAddr: await agent.getAddress() };
  }

  async function fund(token: any, to: string, amount: bigint) {
    const [signer] = await ethers.getSigners();
    await (await (token.connect(signer) as any).mint(to, amount)).wait();
  }

  it("reads the live jackpot's real configuration", async function () {
    const { jackpot } = await deployAgent();

    expect(await jackpot.token()).to.equal(MPUSDC);
    expect(await jackpot.ticketPrice()).to.equal(ONE);
    expect(await jackpot.allowPurchasing()).to.equal(true);

    console.log(`      ticketPrice   ${Number(await jackpot.ticketPrice()) / 1e6}`);
    console.log(`      feeBps        ${await jackpot.feeBps()} (house edge)`);
    console.log(`      referralFeeBps ${await jackpot.referralFeeBps()}`);
    console.log(`      roundDuration ${await jackpot.roundDurationInSeconds()}s`);
  });

  it("the agent reads its pay token from the jackpot itself", async function () {
    const { agent } = await deployAgent();
    expect(await agent.payToken()).to.equal(MPUSDC);
    expect(await agent.bridgeEnabled()).to.equal(false);
  });

  it("buys real Megapot tickets with a CONTRACT as the recipient", async function () {
    const { keeper, jackpot, token, agent, agentAddr } = await deployAgent();

    await fund(token, agentAddr, 100n * ONE);
    expect(await token.balanceOf(agentAddr)).to.equal(100n * ONE);

    const poolBefore = await jackpot.userPoolTotal();
    const [bpsBefore] = await jackpot.usersInfo(agentAddr);

    await (await agent.connect(keeper).buyTickets(25n * ONE)).wait();

    const [bpsAfter, , active] = await jackpot.usersInfo(agentAddr);

    // This is the make-or-break invariant for the whole design: a contract can hold a Megapot
    // position in its own name. Ticket accounting here is pooled bps, not NFTs, so there is no
    // transfer or receiver hook to get wrong.
    expect(bpsAfter).to.be.greaterThan(bpsBefore, "the agent holds tickets");
    expect(active).to.equal(true, "the agent is an active participant");
    expect(await token.balanceOf(agentAddr)).to.equal(75n * ONE, "spent exactly what it was told");
    expect(await agent.totalSpent()).to.equal(25n * ONE);
    expect(await jackpot.userPoolTotal()).to.be.greaterThan(poolBefore, "real money entered the pot");

    console.log(`      agent holds ${bpsAfter - bpsBefore} bps of the live round`);
  });

  it("leaves no standing approval to the jackpot", async function () {
    const { keeper, token, agent, agentAddr } = await deployAgent();
    await fund(token, agentAddr, 10n * ONE);
    await (await agent.connect(keeper).buyTickets(10n * ONE)).wait();

    const erc20 = new ethers.Contract(MPUSDC, ["function allowance(address,address) view returns (uint256)"], ethers.provider);
    expect(await erc20.allowance(agentAddr, JACKPOT)).to.equal(0n);
  });

  it("cannot refer itself — the live contract forbids it", async function () {
    const { governance, agent, agentAddr } = await deployAgent();

    // Guarded locally so a keeper gets a clean error...
    await expect(agent.connect(governance).setReferrer(agentAddr)).to.be.revertedWithCustomError(
      agent,
      "CannotReferSelf",
    );

    // ...and the live jackpot enforces it too, which is where the rule actually comes from.
    // A pool cannot rebate its own house edge by referring itself.
    const raw = new ethers.Contract(
      JACKPOT,
      ["function purchaseTickets(address referrer, uint256 value, address recipient)"],
      ethers.provider,
    );
    const [signer] = await ethers.getSigners();
    const token = new ethers.Contract(MPUSDC, TOKEN_ABI, ethers.provider);
    await fund(token, signer.address, 10n * ONE);
    await (await (token.connect(signer) as any).approve?.(JACKPOT, 10n * ONE).catch(() => null));
    await expect(
      (raw.connect(signer) as any).purchaseTickets(signer.address, ONE, signer.address),
    ).to.be.revertedWith("Cannot refer yourself");
  });

  it("claims real referral fees accrued from another integrator", async function () {
    const { governance, keeper, jackpot, token, agent, agentAddr } = await deployAgent();

    // A second agent points its purchases at the first, which is the legitimate referral shape.
    const partner = await (
      await ethers.getContractFactory("MegapotTicketAgent")
    ).deploy(JACKPOT, ethers.ZeroAddress, 0, ethers.zeroPadValue(governance.address, 32), governance.address, keeper.address);
    await partner.waitForDeployment();
    const partnerAddr = await partner.getAddress();

    await (await partner.connect(governance).setReferrer(agentAddr)).wait();
    await fund(token, partnerAddr, 100n * ONE);
    await (await partner.connect(keeper).buyTickets(50n * ONE)).wait();

    const owed = await jackpot.referralFeesClaimable(agentAddr);
    expect(owed).to.be.greaterThan(0n, "referral fees accrued on the live contract");

    const before = await token.balanceOf(agentAddr);
    await (await agent.claimReferralFees()).wait();
    const got = (await token.balanceOf(agentAddr)) - before;

    expect(got).to.equal(owed, "real fees actually landed in the agent");
    expect(await agent.totalReferralFees()).to.equal(got);
    console.log(`      claimed ${Number(got) / 1e6} in referral fees on 50 spent by the partner`);
  });

  it("refuses to claim what it is not owed", async function () {
    const { agent } = await deployAgent();
    await expect(agent.claimWinnings()).to.be.revertedWithCustomError(agent, "ZeroAmount");
    await expect(agent.claimReferralFees()).to.be.revertedWithCustomError(agent, "ZeroAmount");
  });

  it("gates spending on the keeper and refuses to overspend", async function () {
    const { governance, keeper, token, agent, agentAddr } = await deployAgent();
    const [, , stranger] = await ethers.getSigners();

    await fund(token, agentAddr, 5n * ONE);
    await expect(agent.connect(stranger).buyTickets(ONE)).to.be.revertedWithCustomError(agent, "OnlyKeeper");
    await expect(agent.connect(keeper).buyTickets(50n * ONE)).to.be.revertedWithCustomError(
      agent,
      "InsufficientBalance",
    );
    await expect(agent.connect(keeper).buyTickets(0)).to.be.revertedWithCustomError(agent, "ZeroAmount");

    // Bridging is off on this network, and the agent says so rather than failing obscurely.
    await expect(agent.connect(keeper).bridgeHome(ONE, 0)).to.be.revertedWithCustomError(agent, "BridgingDisabled");

    // The sweep escape hatch exists precisely because the bridge cannot carry this token.
    await (await agent.connect(governance).sweep(MPUSDC, governance.address, 5n * ONE)).wait();
    expect(await token.balanceOf(agentAddr)).to.equal(0n);
  });
});
