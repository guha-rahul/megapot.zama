import { FhevmType } from "@fhevm/hardhat-plugin";
import { task, types } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

import { CHAINS, DOMAIN, assertZamaSupported, cctpFor, usdcFor } from "./addresses";
import { readDeployment, writeDeployment } from "./deployments";

const DAY = 24 * 60 * 60;

/**
 * Wake up the FHE runtime. Tests get this for free; a CLI task has to ask for it before it can
 * encrypt inputs or reach the relayer.
 */
async function initFhevm(hre: HardhatRuntimeEnvironment) {
  await hre.fhevm.initializeCLIApi();
}

/** Publicly decrypt one handle and return the cleartext plus the KMS proof a contract can verify. */
async function publicDecrypt(hre: HardhatRuntimeEnvironment, handle: string) {
  const res = await hre.fhevm.publicDecrypt([handle]);
  return { value: BigInt(Object.values(res.clearValues)[0] as bigint), proof: res.decryptionProof };
}

async function pot(hre: HardhatRuntimeEnvironment) {
  const d = readDeployment(hre.network.name);
  return hre.ethers.getContractAt("MegaPot", d.megaPot);
}

async function cToken(hre: HardhatRuntimeEnvironment) {
  const d = readDeployment(hre.network.name);
  return hre.ethers.getContractAt("ConfidentialUSDC", d.confidentialUSDC);
}

// --------------------------------------------------------------------------- //
//                                  Deploy                                      //
// --------------------------------------------------------------------------- //

task("megapot:deploy", "Deploy the confidential pool against live infrastructure")
  .addOptionalParam("usdc", "Underlying ERC-20 (defaults to the chain's canonical USDC)")
  .addOptionalParam("vault", "An ERC-4626 vault over that USDC to earn yield in (optional)")
  .addFlag("mockVault", "Deploy a MockYieldVault over the USDC and use that as the venue")
  .addOptionalParam("keeper", "Keeper address (defaults to the deployer)")
  .addOptionalParam("agent", "MegapotTicketAgent address on Base, if already deployed")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const chainId = Number((await ethers.provider.getNetwork()).chainId);

    // The pool's FHE half only exists where Zama is deployed. Fail here rather than at the first
    // encrypted operation.
    assertZamaSupported(chainId);

    const [deployer] = await ethers.getSigners();
    const keeper = args.keeper ?? deployer.address;
    const usdcAddr: string = args.usdc ?? usdcFor(chainId);
    const cctp = cctpFor(chainId);

    console.log(`network  ${hre.network.name} (${chainId})`);
    console.log(`deployer ${deployer.address}`);
    console.log(`keeper   ${keeper}`);
    console.log(`USDC     ${usdcAddr}`);
    console.log(`CCTP     ${cctp.tokenMessenger}\n`);

    const cUSDC = await (
      await ethers.getContractFactory("ConfidentialUSDC")
    ).deploy(usdcAddr, "Confidential USDC", "cUSDC", "");
    await cUSDC.waitForDeployment();
    console.log(`ConfidentialUSDC    ${await cUSDC.getAddress()}`);

    const megaPot = await (
      await ethers.getContractFactory("MegaPot")
    ).deploy(await cUSDC.getAddress(), deployer.address, keeper);
    await megaPot.waitForDeployment();
    const potAddr = await megaPot.getAddress();
    console.log(`MegaPot             ${potAddr}`);

    const inbox = await (await ethers.getContractFactory("PrizeInbox")).deploy(potAddr);
    await inbox.waitForDeployment();
    const inboxAddr = await inbox.getAddress();
    console.log(`PrizeInbox          ${inboxAddr}   <- point the Base agent here`);

    // Testnet has no healthy ERC-4626 venue over Circle's USDC — Aave's Sepolia market runs at
    // over 100% utilisation on a couple of dozen dollars of liquidity, and uses its own test
    // token. So the mock vault is the honest way to make the *whole* yield path executable here:
    // deploy, harvest and top-up all run for real, and pointing at a live venue on mainnet is a
    // one-argument change with no contract edit.
    let vaultAddr: string | undefined = args.vault;
    if (!vaultAddr && args.mockVault) {
      const vault = await (await ethers.getContractFactory("MockYieldVault")).deploy(usdcAddr);
      await vault.waitForDeployment();
      vaultAddr = await vault.getAddress();
      console.log(`MockYieldVault      ${vaultAddr}`);
    }

    let yieldSource: string | undefined;
    if (vaultAddr) {
      const source = await (
        await ethers.getContractFactory("ERC4626YieldSource")
      ).deploy(vaultAddr, potAddr, usdcAddr);
      await source.waitForDeployment();
      yieldSource = await source.getAddress();
      await (await megaPot.setYieldSource(yieldSource)).wait();
      console.log(`ERC4626YieldSource  ${yieldSource}`);
    } else {
      console.log(`ERC4626YieldSource  (none — prize funded via fundPrize / fundTicketBudget)`);
    }

    if (args.agent) {
      await (await megaPot.setMegapotRoute(cctp.tokenMessenger, DOMAIN.base, args.agent)).wait();
      console.log(`\nMegapot route wired to agent ${args.agent} on Base (domain ${DOMAIN.base})`);
    }

    writeDeployment(hre.network.name, {
      network: hre.network.name,
      chainId,
      usdc: usdcAddr,
      confidentialUSDC: await cUSDC.getAddress(),
      megaPot: potAddr,
      prizeInbox: inboxAddr,
      yieldVault: vaultAddr ?? null,
      yieldSource: yieldSource ?? null,
      tokenMessenger: cctp.tokenMessenger,
      messageTransmitter: cctp.messageTransmitter,
      keeper,
    });
    console.log(`\nwrote deployments/${hre.network.name}.json`);
    console.log(
      `\nNext: deploy the Base agent pointing at this inbox --\n` +
        `  npx hardhat --config hardhat.megapot.config.ts megapot-base:deploy --inbox ${inboxAddr} --network baseSepolia\n` +
        `then re-run this with --agent <agentAddress> to wire the route.`,
    );
  });

task("megapot:wire-route", "Point the pool at a MegapotTicketAgent on Base")
  .addParam("agent", "MegapotTicketAgent address on Base")
  .setAction(async (args, hre) => {
    const d = readDeployment(hre.network.name) as any;
    const pot = await hre.ethers.getContractAt("MegaPot", d.megaPot);
    await (await pot.setMegapotRoute(d.tokenMessenger, DOMAIN.base, args.agent)).wait();
    // How much yield gets played is each depositor's own call, not a deployment argument — the
    // route just makes it possible to spend at all.
    console.log(`route -> ${args.agent} on domain ${DOMAIN.base}`);
  });

task("megapot:fund-tickets", "Fund the Megapot ticket budget with USDC from your wallet")
  .addParam("amount", "USDC units, e.g. 25", undefined, types.string)
  .setAction(async (args, hre) => {
    const d = readDeployment(hre.network.name) as any;
    const pot = await hre.ethers.getContractAt("MegaPot", d.megaPot);
    const usdc = await hre.ethers.getContractAt("IERC20", d.usdc);
    const amount = hre.ethers.parseUnits(args.amount, 6);

    await (await usdc.approve(d.megaPot, amount)).wait();
    await (await pot.fundTicketBudget(amount)).wait();
    console.log(`ticket budget now ${Number(await pot.ticketBudget()) / 1e6} USDC`);
  });

task("megapot:bridge-tickets", "Burn the ticket budget to CCTP for the agent on Base")
  .addOptionalParam("amount", "USDC units; defaults to the whole budget")
  .addOptionalParam("maxFee", "Cap on the CCTP fee", "0")
  .setAction(async (args, hre) => {
    const d = readDeployment(hre.network.name) as any;
    const pot = await hre.ethers.getContractAt("MegaPot", d.megaPot);
    const amount = args.amount ? hre.ethers.parseUnits(args.amount, 6) : await pot.ticketBudget();

    await (await pot.bridgeToMegapot(amount, BigInt(args.maxFee))).wait();
    console.log(
      `burned ${Number(amount) / 1e6} USDC to CCTP for the agent on Base.\n` +
        `Fetch Circle's attestation, then call MessageTransmitterV2.receiveMessage on Base.`,
    );
  });

task("megapot:flush-inbox", "Fold arrived Megapot winnings into the confidential prize").setAction(
  async (_args, hre) => {
    const d = readDeployment(hre.network.name) as any;
    const inbox = await hre.ethers.getContractAt("PrizeInbox", d.prizeInbox);
    const pending = await inbox.pending();
    if (pending === 0n) {
      console.log("nothing has arrived from Base yet");
      return;
    }
    await (await inbox.flush()).wait();
    console.log(`folded ${Number(pending) / 1e6} USDC of Megapot winnings into the prize reserve`);
  },
);

// --------------------------------------------------------------------------- //
//                              Round lifecycle                                 //
// --------------------------------------------------------------------------- //

/** Track ids, mirroring `MegaPot.MAIN` / `MegaPot.MEGA`. */
const TRACKS: Record<string, number> = { main: 0, mega: 1 };

/** Resolve a `--track main|mega` argument to the contract's uint8. */
function trackOf(name: string): number {
  const id = TRACKS[String(name).toLowerCase()];
  if (id === undefined) throw new Error(`unknown track "${name}" — expected "main" or "mega"`);
  return id;
}

task("megapot:start-round", "Open a new draw round")
  .addOptionalParam("in", "Seconds until the draw may run", DAY, types.int)
    .addOptionalParam("track", 'Prize track: "main" or "mega"', "main", types.string)
.setAction(async (args, hre) => {
    const p = await pot(hre);
    const track = trackOf(args.track);
    const drawTime = Math.floor(Date.now() / 1000) + args.in;
    await (await p.startRound(track, drawTime)).wait();
    const roundId = (await p.roundsLength(track)) - 1n;
    console.log(`round ${roundId} open, draws at ${new Date(drawTime * 1000).toISOString()}`);
  });

task("megapot:close-entries", "Close entries and reveal the round's ticket total")
  .addParam("round", "Round id", undefined, types.int)
    .addOptionalParam("track", 'Prize track: "main" or "mega"', "main", types.string)
.setAction(async (args, hre) => {
    await initFhevm(hre);
    const p = await pot(hre);
    const track = trackOf(args.track);
    await (await p.closeEntries(track, args.round)).wait();

    const round = await p.getRound(track, args.round);
    const { value, proof } = await publicDecrypt(hre, round.cursorSnapshot);
    await (await p.finalizeEntries(track, args.round, value, proof)).wait();
    console.log(`round ${args.round}: ${Number(value) / 1e6} tickets in play`);
  });

task("megapot:deploy-funds", "Unwrap the pending deposit batch and invest it").setAction(async (_args, hre) => {
  await initFhevm(hre);
  const p = await pot(hre);
  const c = await cToken(hre);

  const tx = await p.requestDeploy();
  const receipt = await tx.wait();
  const topic = p.interface.getEvent("DeployRequested")!.topicHash;
  const log = receipt!.logs.find((l: any) => l.topics[0] === topic);
  if (!log) throw new Error("DeployRequested not emitted");
  const id = p.interface.parseLog(log as any)!.args.unwrapRequestId as string;

  const { value, proof } = await publicDecrypt(hre, id);
  if (value === 0n) {
    console.log("nothing pending");
    return;
  }
  await (await c.finalizeUnwrap(id, value, proof)).wait();
  await (await p.invest()).wait();
  console.log(`deployed ${Number(value) / 1e6} USDC into the yield source`);
});

task("megapot:harvest", "Skim yield above principal into the prize reserve").setAction(async (_args, hre) => {
  const p = await pot(hre);
  await (await p.harvest()).wait();
  console.log(`prize reserve: ${Number(await p.prizeReserve()) / 1e6} USDC`);
});

task("megapot:draw", "Run the draw for a round")
  .addParam("round", "Round id", undefined, types.int)
  .addOptionalParam("window", "Claim window in seconds", 7 * DAY, types.int)
    .addOptionalParam("track", 'Prize track: "main" or "mega"', "main", types.string)
.setAction(async (args, hre) => {
    const p = await pot(hre);
    const track = trackOf(args.track);
    await (await p.draw(track, args.round, args.window)).wait();
    const round = await p.getRound(track, args.round);
    console.log(
      `round ${args.round} drawn — prize ${Number(round.prize) / 1e6} USDC over ` +
        `${Number(round.totalTickets) / 1e6} tickets. The winner is encrypted; depositors claim to find out.`,
    );
  });

task("megapot:sweep", "Roll an unclaimed prize into the next round")
  .addParam("round", "Round id", undefined, types.int)
    .addOptionalParam("track", 'Prize track: "main" or "mega"', "main", types.string)
.setAction(async (args, hre) => {
    await initFhevm(hre);
    const p = await pot(hre);
    const track = trackOf(args.track);
    await (await p.requestSweep(track, args.round)).wait();

    const round = await p.getRound(track, args.round);
    const { value, proof } = await publicDecrypt(hre, round.unclaimed);
    await (await p.finalizeSweep(track, args.round, value, proof)).wait();
    console.log(
      value === 0n
        ? `round ${args.round} was won and fully claimed`
        : `round ${args.round} found no owner — ${Number(value) / 1e6} USDC rolls over`,
    );
  });

task("megapot:refill", "Top up the confidential withdrawal buffer")
  .addParam("amount", "Underlying units, e.g. 500 for 500 USDC", undefined, types.string)
  .setAction(async (args, hre) => {
    const p = await pot(hre);
    const amount = hre.ethers.parseUnits(args.amount, 6);
    await (await p.refillBuffer(amount)).wait();
    console.log(`buffer topped up with ${args.amount} USDC`);
  });

// --------------------------------------------------------------------------- //
//                                  Status                                      //
// --------------------------------------------------------------------------- //

task("megapot:status", "Show the pool's public state").setAction(async (_args, hre) => {
  const p = await pot(hre);
  const rounds = Number(await p.roundsLength(0));
  const states = ["None", "Open", "Closing", "Drawable", "Claimable", "Sweeping", "Settled"];

  console.log(`deployed principal : ${Number(await p.deployedPrincipal()) / 1e6} USDC`);
  console.log(`prize reserve      : ${Number(await p.prizeReserve()) / 1e6} USDC`);
  console.log(`tickets in play    : ${Number(await p.settledTickets()) / 1e6}`);
  console.log(`entry round        : ${await p.entryRound()}`);
  console.log(`rounds             : ${rounds}`);
  console.log(`ticket budget      : ${Number(await p.ticketBudget()) / 1e6} USDC`);
  console.log(`megapot share      : ${await p.megapotShareBps()} bps of the next harvest`);
  console.log(`megapot agent      : ${await p.ticketAgent()}`);

  for (let i = Math.max(0, rounds - 5); i < rounds; i++) {
    const r = await p.getRound(0, i);
    console.log(
      `  #${i} ${states[Number(r.state)].padEnd(9)} prize ${String(Number(r.prize) / 1e6).padStart(8)} ` +
        `tickets ${String(Number(r.totalTickets) / 1e6).padStart(10)} draws ${new Date(
          Number(r.drawTime) * 1000,
        ).toISOString()}`,
    );
  }
});

// --------------------------------------------------------------------------- //
//                          Local-network conveniences                          //
// --------------------------------------------------------------------------- //

// --------------------------------------------------------------------------- //
//                          Depositor-side commands                             //
// --------------------------------------------------------------------------- //
//
// The same three steps a dapp performs in the browser with the Zama relayer SDK: encrypt the
// amount client-side, submit the ciphertext plus its proof, and decrypt your own handles.

task("megapot:deposit", "Deposit an encrypted amount into the pool")
  .addParam("amount", "Underlying units, e.g. 1000", undefined, types.string)
  .addOptionalParam("account", "Index of the signer depositing", 0, types.int)
  .setAction(async (args, hre) => {
    await initFhevm(hre);
    const d = readDeployment(hre.network.name);
    const signer = (await hre.ethers.getSigners())[args.account];
    const p = (await hre.ethers.getContractAt("MegaPot", d.megaPot)).connect(signer) as any;

    const input = hre.fhevm.createEncryptedInput(d.megaPot, signer.address);
    input.add64(hre.ethers.parseUnits(args.amount, 6));
    const enc = await input.encrypt();

    await (await p.deposit(enc.handles[0], enc.inputProof)).wait();
    console.log(`${signer.address} deposited an encrypted amount — nothing on-chain reveals how much`);
  });

task("megapot:withdraw", "Withdraw an encrypted amount back to your cUSDC balance")
  .addParam("amount", "Underlying units", undefined, types.string)
  .addOptionalParam("account", "Index of the signer withdrawing", 0, types.int)
  .setAction(async (args, hre) => {
    await initFhevm(hre);
    const d = readDeployment(hre.network.name);
    const signer = (await hre.ethers.getSigners())[args.account];
    const p = (await hre.ethers.getContractAt("MegaPot", d.megaPot)).connect(signer) as any;

    const input = hre.fhevm.createEncryptedInput(d.megaPot, signer.address);
    input.add64(hre.ethers.parseUnits(args.amount, 6));
    const enc = await input.encrypt();

    await (await p.withdraw(enc.handles[0], enc.inputProof)).wait();
    const paid = await hre.fhevm.userDecryptEuint(
      FhevmType.euint64,
      await p.lastWithdrawnOf(signer.address),
      d.megaPot,
      signer,
    );
    console.log(`paid out ${Number(paid) / 1e6} USDC (0 means the buffer is empty — ask the keeper to refill)`);
  });

task("megapot:claim", "Claim a round — wins and losses are indistinguishable on-chain")
  .addParam("round", "Round id", undefined, types.int)
  .addOptionalParam("account", "Index of the signer claiming", 0, types.int)
    .addOptionalParam("track", 'Prize track: "main" or "mega"', "main", types.string)
.setAction(async (args, hre) => {
    await initFhevm(hre);
    const d = readDeployment(hre.network.name);
    const signer = (await hre.ethers.getSigners())[args.account];
    const p = (await hre.ethers.getContractAt("MegaPot", d.megaPot)).connect(signer) as any;
    const track = trackOf(args.track);

    await (await p.claim(track, args.round)).wait();

    // Read the award from its own handle rather than diffing the balance either side. The claim
    // writes one for every claimer, and a loser's decrypts to zero — so asking "what did I win?"
    // is a single decryption that reveals nothing by having been asked.
    const award = await hre.fhevm.userDecryptEuint(
      FhevmType.euint64,
      await p.awardOf(track, args.round, signer.address),
      d.megaPot,
      signer,
    );

    console.log(
      award > 0n
        ? `🎉 you won ${Number(award) / 1e6} USDC — only you can see this`
        : "no win this round — and an observer cannot tell that from a win",
    );
  });

task("megapot:balance", "Decrypt your own pool balance and odds")
  .addOptionalParam("account", "Index of the signer", 0, types.int)
  .setAction(async (args, hre) => {
    await initFhevm(hre);
    const d = readDeployment(hre.network.name);
    const signer = (await hre.ethers.getSigners())[args.account];
    const p = await hre.ethers.getContractAt("MegaPot", d.megaPot);

    const handle = await p.confidentialBalanceOf(signer.address);
    const balance =
      handle === hre.ethers.ZeroHash
        ? 0n
        : await hre.fhevm.userDecryptEuint(FhevmType.euint64, handle, d.megaPot, signer);

    let tickets = 0n;
    for (const range of await p.rangesOf(0, signer.address)) {
      const lower = await hre.fhevm.userDecryptEuint(FhevmType.euint64, range.lower, d.megaPot, signer);
      const upper = await hre.fhevm.userDecryptEuint(FhevmType.euint64, range.upper, d.megaPot, signer);
      tickets += upper - lower;
    }

    // The denominator only exists once entries close and the cursor total is revealed. Before
    // that your odds are not zero, they are simply not yet determined — printing "0.00%" would be
    // a wrong answer where "not yet" is the right one.
    const total = await p.settledTickets();
    const odds =
      total > 0n
        ? `${((Number(tickets) / Number(total)) * 100).toFixed(2)}% odds`
        : "odds are set when entries close for this round";

    console.log(`${signer.address}`);
    console.log(`  balance : ${Number(balance) / 1e6} USDC   (encrypted on-chain)`);
    console.log(`  tickets : ${Number(tickets) / 1e6}${total > 0n ? ` of ${Number(total) / 1e6}` : ""}  →  ${odds}`);
  });
