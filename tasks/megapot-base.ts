import { task, types } from "hardhat/config";

import { DOMAIN, cctpFor, megapotFor } from "./addresses";
import { readDeployment, writeDeployment } from "./deployments";

/**
 * The Base half: the agent that plays the real Megapot lottery.
 *
 *   npx hardhat --config hardhat.megapot.config.ts <task> --network baseSepolia
 */

task("megapot-base:deploy", "Deploy the Megapot ticket agent against the live jackpot")
  .addParam("inbox", "The PrizeInbox address on the pool's chain (winnings land there)")
  .addOptionalParam("keeper", "Keeper address (defaults to the deployer)")
  .addOptionalParam("referrer", "Referrer credited on purchases; cannot be the agent itself")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const megapot = megapotFor(chainId);
    const cctp = cctpFor(chainId);

    const [deployer] = await ethers.getSigners();
    const keeper = args.keeper ?? deployer.address;

    // On Base Sepolia the jackpot settles in its own TestTokenUSDC, which CCTP cannot carry, so
    // the agent is deployed with bridging disabled and winnings are swept by governance instead.
    const bridgeable = megapot.payTokenIsUsdc;
    const tokenMessenger = bridgeable ? cctp.tokenMessenger : ethers.ZeroAddress;

    console.log(`network   ${hre.network.name} (${chainId})`);
    console.log(`jackpot   ${megapot.jackpot}`);
    console.log(
      `payToken  ${megapot.payToken}${bridgeable ? " (USDC — bridgeable)" : " (test token — NOT bridgeable)"}`,
    );
    console.log(`bridge    ${bridgeable ? tokenMessenger : "disabled"}`);
    console.log(`inbox     ${args.inbox} on domain ${DOMAIN.ethereum}\n`);

    const agent = await (
      await ethers.getContractFactory("MegapotTicketAgent")
    ).deploy(
      megapot.jackpot,
      tokenMessenger,
      DOMAIN.ethereum,
      ethers.zeroPadValue(args.inbox, 32),
      deployer.address,
      keeper,
    );
    await agent.waitForDeployment();
    const agentAddr = await agent.getAddress();
    console.log(`MegapotTicketAgent  ${agentAddr}`);

    if (args.referrer) {
      await (await agent.setReferrer(args.referrer)).wait();
      console.log(`referrer set to ${args.referrer}`);
    }

    writeDeployment(`${hre.network.name}-base`, {
      network: hre.network.name,
      chainId,
      jackpot: megapot.jackpot,
      payToken: megapot.payToken,
      agent: agentAddr,
      tokenMessenger,
      inbox: args.inbox,
      keeper,
    } as never);
    console.log(`\nwrote deployments/${hre.network.name}-base.json`);
  });

task("megapot-base:buy", "Spend the agent's balance on real Megapot tickets")
  .addParam("amount", "Pay-token units, e.g. 25", undefined, types.string)
  .setAction(async (args, hre) => {
    const d = readDeployment(`${hre.network.name}-base`) as any;
    const agent = await hre.ethers.getContractAt("MegapotTicketAgent", d.agent);
    const amount = hre.ethers.parseUnits(args.amount, 6);

    const before = await agent.ticketsHeldBps();
    await (await agent.buyTickets(amount)).wait();

    // Public RPCs are load-balanced, so the node answering the next read may not have the block
    // yet. Poll until the position actually moves rather than reporting a stale zero.
    let held = before;
    for (let i = 0; i < 10 && held === before; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      held = await agent.ticketsHeldBps();
    }
    console.log(`bought ${args.amount} worth — agent now holds ${held} bps of the round`);
  });

task("megapot-base:claim", "Claim winnings from the live jackpot").setAction(async (_args, hre) => {
  const d = readDeployment(`${hre.network.name}-base`) as any;
  const agent = await hre.ethers.getContractAt("MegapotTicketAgent", d.agent);

  const owed = await agent.claimable();
  if (owed === 0n) {
    console.log("nothing owed by the jackpot");
    return;
  }
  await (await agent.claimWinnings()).wait();
  console.log(`claimed ${Number(owed) / 1e6} in winnings`);
});

task("megapot-base:bridge", "Send the agent's balance home through CCTP")
  .addOptionalParam("maxFee", "Cap on the CCTP fee (0 for standard transfers)", "0", types.string)
  .setAction(async (args, hre) => {
    const d = readDeployment(`${hre.network.name}-base`) as any;
    const agent = await hre.ethers.getContractAt("MegapotTicketAgent", d.agent);

    if (!(await agent.bridgeEnabled())) {
      throw new Error(
        "bridging is disabled on this deployment — the jackpot's pay token is not CCTP-transferable " +
          "(true on Base Sepolia). Use the sweep escape hatch, or run on Base mainnet where Megapot " +
          "settles in real USDC.",
      );
    }
    const bridged = await agent.harvestAndBridge.staticCall(BigInt(args.maxFee));
    await (await agent.harvestAndBridge(BigInt(args.maxFee))).wait();
    console.log(
      `burned ${Number(bridged) / 1e6} to CCTP for the PrizeInbox at ${d.inbox}.\n` +
        `Next: fetch Circle's attestation, call MessageTransmitterV2.receiveMessage on the pool's chain,\n` +
        `then PrizeInbox.flush() to fold it into the confidential prize.`,
    );
  });

task("megapot-base:status", "Show the agent's live position").setAction(async (_args, hre) => {
  const d = readDeployment(`${hre.network.name}-base`) as any;
  const agent = await hre.ethers.getContractAt("MegapotTicketAgent", d.agent);
  const jackpot = await hre.ethers.getContractAt("IBaseJackpot", d.jackpot);
  const token = await hre.ethers.getContractAt("IERC20", d.payToken);

  const endsAt = Number(await agent.roundEndsAt());
  console.log(`agent          ${d.agent}`);
  console.log(`pay token bal  ${Number(await token.balanceOf(d.agent)) / 1e6}`);
  console.log(`tickets held   ${await agent.ticketsHeldBps()} bps of ${await jackpot.ticketCountTotalBps()}`);
  console.log(`claimable      ${Number(await agent.claimable()) / 1e6}`);
  console.log(`spent / won    ${Number(await agent.totalSpent()) / 1e6} / ${Number(await agent.totalWon()) / 1e6}`);
  console.log(`realised       ${await agent.realisedReturnBps()} bps (10000 = break-even)`);
  console.log(`house edge     ${await jackpot.feeBps()} bps`);
  console.log(
    `round ends     ${new Date(endsAt * 1000).toISOString()}${endsAt < Date.now() / 1000 ? "  (settleable now)" : ""}`,
  );
});

task("megapot-base:faucet", "Mint Megapot's test token to the agent (Base Sepolia only)")
  .addParam("amount", "Units, e.g. 100", undefined, types.string)
  .setAction(async (args, hre) => {
    const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
    if (chainId !== 84532) throw new Error("the Megapot test-token faucet only exists on Base Sepolia");

    const d = readDeployment(`${hre.network.name}-base`) as any;
    const token = await hre.ethers.getContractAt("IMintableTestToken", d.payToken);
    await (await token.mint(d.agent, hre.ethers.parseUnits(args.amount, 6))).wait();
    console.log(`minted ${args.amount} TestTokenUSDC to the agent`);
  });

// --------------------------------------------------------------------------- //
//                      Complete a CCTP transfer on Base                        //
// --------------------------------------------------------------------------- //

/**
 * Finish an Ethereum → Base CCTP transfer.
 *
 * The burn already happened on the source chain; Circle attests it once the burn reaches hard
 * finality (~15 minutes from Ethereum). This polls for that attestation and then submits it.
 *
 * `receiveMessage` is permissionless — the burn fixed `mintRecipient`, so whoever pays the gas
 * cannot redirect a single unit. Anyone can rescue a stalled transfer.
 */
task("megapot-base:receive", "Complete a CCTP transfer whose burn happened on Ethereum")
  .addParam("tx", "The source-chain transaction hash of the burn")
  .addOptionalParam("wait", "Seconds to keep polling for the attestation", "0")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const IRIS = "https://iris-api-sandbox.circle.com/v2/messages/0";
    const MESSAGE_TRANSMITTER = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";

    const deadline = Date.now() + Number(args.wait) * 1000;
    let msg: { message: string; attestation: string } | undefined;

    for (;;) {
      const res: any = await fetch(`${IRIS}?transactionHash=${args.tx}`).then((r) => r.json());
      const m = res?.messages?.[0];
      if (m?.status === "complete" && m.attestation && m.attestation !== "PENDING") {
        msg = { message: m.message, attestation: m.attestation };
        break;
      }
      const state = m?.status ?? res?.error ?? "unknown";
      if (Date.now() >= deadline) {
        console.log(`attestation not ready yet (status: ${state}).`);
        console.log("Circle needs hard finality on Ethereum — roughly 15 minutes. Re-run this task later.");
        return;
      }
      console.log(`  attestation ${state} — waiting…`);
      await new Promise((r) => setTimeout(r, 20_000));
    }

    const [signer] = await ethers.getSigners();
    const bal = await ethers.provider.getBalance(signer.address);
    if (bal === 0n) {
      console.log(`${signer.address} has no ETH on ${hre.network.name}. Fund it and re-run.`);
      return;
    }

    const mt = new ethers.Contract(
      MESSAGE_TRANSMITTER,
      ["function receiveMessage(bytes message, bytes attestation) returns (bool)"],
      signer,
    );
    console.log("submitting receiveMessage…");
    const tx = await mt.receiveMessage(msg!.message, msg!.attestation);
    const rc = await tx.wait();
    console.log(`✅ minted on ${hre.network.name} — tx ${rc?.hash}`);
    console.log("   The agent now holds the bridged USDC. Verify with megapot-base:status.");
  });
