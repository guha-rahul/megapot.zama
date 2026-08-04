import { expect } from "chai";
import hre from "hardhat";

const { ethers, artifacts } = hre;

/**
 * The bridge leg, exercised against the **live CCTP V2 deployment on Base Sepolia** with real
 * Circle USDC. No stand-ins: this calls the same `TokenMessengerV2` proxy production would.
 *
 *   npx hardhat --config hardhat.megapot.config.ts test test/Cctp.fork.ts
 *
 * What it proves is narrow but exactly what can silently be wrong: that the `ITokenMessengerV2`
 * interface this repo compiles against matches the live contract's ABI, and that the parameters
 * MegaPot and the agent pass are accepted — including that the burn really destroys the tokens
 * and names an unchangeable destination.
 */
const TOKEN_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const MESSAGE_TRANSMITTER = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MASTER_MINTER = "0xD52081E444544C744B3ECbb0dE7fF06e63ef4E1c";

const ETHEREUM_DOMAIN = 0;
const FINALITY_STANDARD = 2000;
const ONE = 1_000_000n;

const USDC_ABI = [
  "function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
  "function mint(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

describe("CCTP V2 — live Base Sepolia", function () {
  before(async function () {
    const net = await ethers.provider.getNetwork();
    if (net.chainId !== 84532n) {
      console.log("      (skipped — run with --config hardhat.megapot.config.ts)");
      this.skip();
    }
  });

  /** Mint real USDC by impersonating Circle's master minter — real contract, real code path. */
  async function mintUsdc(to: string, amount: bigint) {
    await ethers.provider.send("hardhat_impersonateAccount", [MASTER_MINTER]);
    await ethers.provider.send("hardhat_setBalance", [MASTER_MINTER, "0xde0b6b3a7640000"]);
    const minter = await ethers.getSigner(MASTER_MINTER);
    const usdc = new ethers.Contract(USDC, USDC_ABI, minter);
    await (await usdc.configureMinter(MASTER_MINTER, amount * 10n)).wait();
    await (await usdc.mint(to, amount)).wait();
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [MASTER_MINTER]);
  }

  it("this repo's ITokenMessengerV2 matches the live contract", async function () {
    const artifact = await artifacts.readArtifact("ITokenMessengerV2");
    const ours = new ethers.Interface(artifact.abi);

    // The exact signature read off the verified implementation at
    // 0xf80e9E448F9d8cBFc42703419D78fE36FC350b76. If Circle ever changes it, this fails here
    // rather than at a keeper's first bridge attempt.
    expect(ours.getFunction("depositForBurn")!.format("sighash")).to.equal(
      "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
    );

    // Encoding through our ABI must produce the selector the live proxy routes. That the live
    // contract genuinely accepts this calldata is proven by the burn test below.
    const [caller] = await ethers.getSigners();
    const data = ours.encodeFunctionData("depositForBurn", [
      ONE,
      ETHEREUM_DOMAIN,
      ethers.zeroPadValue(caller.address, 32),
      USDC,
      ethers.ZeroHash,
      0,
      FINALITY_STANDARD,
    ]);
    expect(data.slice(0, 10)).to.equal(ours.getFunction("depositForBurn")!.selector);

    const transmitter = await artifacts.readArtifact("IMessageTransmitterV2");
    const tIface = new ethers.Interface(transmitter.abi);
    expect(tIface.getFunction("receiveMessage")!.format("sighash")).to.equal("receiveMessage(bytes,bytes)");
  });

  it("burns real USDC and addresses it to a fixed recipient on Ethereum", async function () {
    const [caller] = await ethers.getSigners();
    const artifact = await artifacts.readArtifact("ITokenMessengerV2");
    const messenger = new ethers.Contract(TOKEN_MESSENGER, artifact.abi, caller);
    const usdc = new ethers.Contract(USDC, USDC_ABI, caller);

    await mintUsdc(caller.address, 100n * ONE);
    expect(await usdc.balanceOf(caller.address)).to.equal(100n * ONE);

    const supplyBefore = await usdc.totalSupply();
    await (await usdc.approve(TOKEN_MESSENGER, 40n * ONE)).wait();

    // The destination the pool would name: its PrizeInbox on Ethereum.
    const inboxOnEthereum = ethers.Wallet.createRandom().address;
    const mintRecipient = ethers.zeroPadValue(inboxOnEthereum, 32);

    const tx = await messenger.depositForBurn(
      40n * ONE,
      ETHEREUM_DOMAIN,
      mintRecipient,
      USDC,
      ethers.ZeroHash,
      0,
      FINALITY_STANDARD,
    );
    const receipt = await tx.wait();

    expect(await usdc.balanceOf(caller.address)).to.equal(60n * ONE, "USDC left the caller");
    expect(await usdc.totalSupply()).to.equal(supplyBefore - 40n * ONE, "and was genuinely burned");

    // MessageTransmitterV2 emits the message Circle attests; the relayer carries it, and the
    // recipient encoded here is the only address the far side can mint to.
    const messageSent = ethers.id("MessageSent(bytes)");
    const log = receipt!.logs.find(
      (l: any) => l.address.toLowerCase() === MESSAGE_TRANSMITTER.toLowerCase() && l.topics[0] === messageSent,
    );
    expect(log, "MessageSent emitted by the live MessageTransmitterV2").to.not.equal(undefined);

    const [message] = ethers.AbiCoder.defaultAbiCoder().decode(["bytes"], (log as any).data);
    expect(message.toLowerCase()).to.include(inboxOnEthereum.slice(2).toLowerCase(), "recipient is in the message");

    console.log(`      burned 40 USDC on Base Sepolia, addressed to ${inboxOnEthereum} on Ethereum`);
  });

  it("refuses a burn the caller has not approved", async function () {
    const [, other] = await ethers.getSigners();
    const artifact = await artifacts.readArtifact("ITokenMessengerV2");
    const messenger = new ethers.Contract(TOKEN_MESSENGER, artifact.abi, other);

    await mintUsdc(other.address, 10n * ONE);
    await expect(
      messenger.depositForBurn(
        10n * ONE,
        ETHEREUM_DOMAIN,
        ethers.zeroPadValue(other.address, 32),
        USDC,
        ethers.ZeroHash,
        0,
        FINALITY_STANDARD,
      ),
    ).to.be.reverted;
  });
});
