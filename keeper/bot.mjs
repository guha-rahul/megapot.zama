#!/usr/bin/env node
/**
 * MegaPot keeper — drives the round lifecycle unattended.
 *
 * `startRound`, `closeEntries` and `draw` are `onlyKeeper`, so without something running there is
 * nobody to open a round or pull the trigger on one. Everything else in the lifecycle is already
 * permissionless, which is the important safety property here: this process is a *scheduler*, not
 * a custodian. If it dies, deposits and withdrawals keep working and anyone can finish a round
 * that is mid-flight.
 *
 * ## Why it shells out to Hardhat instead of talking to the chain itself
 *
 * Two steps in the lifecycle need a KMS round-trip — `closeEntries` publishes the cursor for
 * public decryption and `finalizeEntries` submits the cleartext with its proof; `requestSweep` and
 * `finalizeSweep` do the same for the unclaimed remainder. That plumbing already exists, is
 * already exercised on this deployment, and lives in `tasks/megapot.ts`. Re-implementing it here
 * against `@zama-fhe/relayer-sdk/node` would double the surface area of the thing most likely to
 * break, to save a subprocess. So the bot decides *what* to do and Hardhat does it.
 *
 * ## What it will not do
 *
 * It never funds a prize and never moves principal. `draw` is skipped when the reserve is empty
 * rather than the bot topping it up: deciding how much money to put in a prize is not a decision
 * to automate. It also never touches the Megapot/Base leg — bridging is a value transfer with a
 * different risk profile and stays manual.
 *
 * Configure with environment variables (see keeper/README.md):
 *   RPC_URL         Sepolia endpoint                  (default: a public one)
 *   POOL            MegaPot address                   (required)
 *   TRACKS          comma-separated: 0=main, 1=mega   (default: 0,1)
 *   JACKPOT         Megapot on Base — the schedule is read from it
 *   BASE_RPC_URL    endpoint for that read             (default: a public one)
 *   ROUND_SECONDS   fallback cadence if Base is unreachable  (default: 21600)
 *   CLAIM_SECONDS   fallback claim window, same condition    (default: 86400)
 *   POLL_SECONDS    how often to look                 (default: 120)
 *   HARDHAT_DIR     repo root holding hardhat.config  (default: the parent of this file)
 *   DRY_RUN         "1" to log decisions and send nothing
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Contract, JsonRpcProvider } from "ethers";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

const CFG = {
  rpc: process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
  pool: process.env.POOL,
  tracks: (process.env.TRACKS || "0,1").split(",").map((t) => Number(t.trim())),
  roundSeconds: Number(process.env.ROUND_SECONDS || 6 * 60 * 60),
  claimSeconds: Number(process.env.CLAIM_SECONDS || 24 * 60 * 60),
  pollSeconds: Number(process.env.POLL_SECONDS || 120),
  hardhatDir: resolve(process.env.HARDHAT_DIR || resolve(HERE, "..")),
  network: process.env.NETWORK || "sepolia",
  jackpot: process.env.JACKPOT,
  baseRpc: process.env.BASE_RPC_URL || "https://sepolia.base.org",
  dryRun: process.env.DRY_RUN === "1",
};

if (!CFG.pool) {
  console.error("POOL is required — set it to the MegaPot address.");
  process.exit(1);
}

const ABI = [
  "function roundsLength(uint8) view returns (uint256)",
  "function getRound(uint8,uint256) view returns (tuple(uint64 drawTime,uint64 totalTickets,uint64 prize,uint64 claimDeadline,uint8 state,bytes32 ticket,bytes32 unclaimed,bytes32 cursorSnapshot))",
  "function trackInfo(uint8) view returns (uint64 entryRound_,uint64 settledTickets_,uint64 prizeReserve_,uint256 rounds_)",
  "function keeper() view returns (address)",
];

const JACKPOT_ABI = [
  "function lastJackpotEndTime() view returns (uint256)",
  "function roundDurationInSeconds() view returns (uint256)",
];

const STATE = ["None", "Open", "Closing", "Drawable", "Claimable", "Sweeping", "Settled"];
const TRACK = ["main", "mega"];

const log = (...a) => console.log(new Date().toISOString(), ...a);

/**
 * The last few lines of output that actually say something.
 *
 * Taking a blind tail of a Hardhat failure gets you stack frames — `at async Environment.run
 * (...runtime-environment.ts:184)` — and drops the one line that names the problem, which is
 * printed above them. Solc also emits NUL bytes that turn the whole stream binary and make it
 * invisible to grep. Strip both, then keep the tail.
 */
function meaningful(out) {
  return String(out ?? "")
    .replace(/\0/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^\s+at /.test(l))
    .slice(-3)
    .join(" | ")
    .slice(0, 400);
}

/**
 * Invoke one Hardhat task.
 *
 * Failures are logged and swallowed on purpose. Every action here is idempotent at the contract
 * level — the state machine rejects a call that no longer applies — so the right response to a
 * transient RPC or relayer error is to try again on the next tick, not to take the process down
 * and lose the schedule for the other track.
 */
async function hardhat(args) {
  const line = `npx hardhat ${args.join(" ")} --network ${CFG.network}`;
  if (CFG.dryRun) {
    log("DRY_RUN would run:", line);
    return true;
  }
  log("→", line);
  try {
    const { stdout } = await run("npx", ["hardhat", ...args, "--network", CFG.network], {
      cwd: CFG.hardhatDir,
      timeout: 10 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    });
    log("  ok:", meaningful(stdout) || "(no output)");
    return true;
  } catch (e) {
    log("  failed:", meaningful(e.stderr || e.message) || "(no detail)");
    return false;
  }
}

/**
 * How far out to set a new round's draw time, in seconds from now.
 *
 * The MEGA track's prize is whatever comes back from the real Megapot jackpot, so its rounds
 * should settle in step with the jackpot that funds them rather than on a cadence we invented.
 * Megapot publishes exactly that: `lastJackpotEndTime + roundDurationInSeconds` is when its
 * current round settles — daily on Base mainnet, five minutes on Base Sepolia.
 *
 * Two guards. The floor matters because Base Sepolia's jackpot has not been run since February,
 * so its "next settlement" is months in the past; without a floor that would open rounds that are
 * instantly drawable and give nobody time to enter. And a failed cross-chain read falls back to
 * `ROUND_SECONDS` rather than skipping the round — a dead Base endpoint should not stop the
 * confidential pool from drawing.
 */
async function schedule(track, now) {
  const fallback = { lead: CFG.roundSeconds, claim: CFG.claimSeconds, derived: false };
  if (!CFG.jackpot) return fallback;

  try {
    const base = new JsonRpcProvider(CFG.baseRpc);
    const j = new Contract(CFG.jackpot, JACKPOT_ABI, base);
    const [end, durRaw] = await Promise.all([j.lastJackpotEndTime(), j.roundDurationInSeconds()]);
    const dur = Number(durRaw);
    if (!Number.isFinite(dur) || dur <= 0) return fallback;

    // The MEGA track's prize comes back from this jackpot, so its round should land on the
    // jackpot's own settlement rather than near it. When that moment has already passed — Base
    // Sepolia's jackpot has not been run since February — fall to one full duration out, which
    // is still Megapot's number rather than one of ours.
    const settlesAt = Number(end) + dur;
    const aligned = settlesAt - now;
    const lead = track === 1 && aligned > 0 ? aligned : dur;

    // Claims stay open exactly one round. Any shorter and a depositor can miss a win between
    // draws; any longer and two rounds are claimable at once, which the sweep would rather avoid.
    log(
      `[${TRACK[track]}] Megapot round is ${dur}s` +
        (track === 1 && aligned > 0
          ? `; next settles ${new Date(settlesAt * 1000).toISOString()}`
          : "; jackpot idle, using one full round") +
        ` → draw in ${lead}s, claims open ${dur}s`,
    );
    return { lead, claim: dur, derived: true };
  } catch (e) {
    log(
      `[${TRACK[track]}] could not read Megapot's schedule, falling back:`,
      String(e.shortMessage || e.message).slice(0, 120),
    );
    return fallback;
  }
}

/** Decide and perform at most one action for one track. One per tick keeps the log readable. */
async function tick(pot, provider, track) {
  const name = TRACK[track] ?? String(track);
  const now = (await provider.getBlock("latest")).timestamp;
  const n = Number(await pot.roundsLength(track));
  const info = await pot.trackInfo(track);
  const reserve = info.prizeReserve_;

  if (n === 0) {
    log(`[${name}] no rounds yet`);
    return hardhat(["megapot:start-round", "--track", name, "--in", String((await schedule(track, now)).lead)]);
  }

  const id = n - 1;
  const r = await pot.getRound(track, id);
  const state = Number(r.state);
  log(
    `[${name}] round ${id} ${STATE[state]} · reserve ${Number(reserve) / 1e6} USDC` +
      (state === 1 ? ` · draws in ${Number(r.drawTime) - now}s` : ""),
  );

  switch (state) {
    case 1: // Open — close once the draw time has passed.
      if (now >= Number(r.drawTime)) {
        return hardhat(["megapot:close-entries", "--track", name, "--round", String(id)]);
      }
      return false;

    case 2: // Closing — the cursor is published; finalise it. `close-entries` does both phases.
      return hardhat(["megapot:close-entries", "--track", name, "--round", String(id)]);

    case 3: // Drawable — draw, but never fund the prize ourselves.
      if (now < Number(r.drawTime)) return false;
      if (reserve === 0n) {
        log(`[${name}] reserve is empty — not drawing. Fund it with megapot:fund-prize.`);
        return false;
      }
      return hardhat([
        "megapot:draw",
        "--track",
        name,
        "--round",
        String(id),
        "--window",
        String((await schedule(track, now)).claim),
      ]);

    case 4: // Claimable — sweep once the window closes, which rolls any unclaimed prize forward.
      if (now < Number(r.claimDeadline)) return false;
      return hardhat(["megapot:sweep", "--track", name, "--round", String(id)]);

    case 5: // Sweeping — finish the KMS round-trip. `sweep` runs both phases.
      return hardhat(["megapot:sweep", "--track", name, "--round", String(id)]);

    case 6: // Settled — open the next one.
      return hardhat(["megapot:start-round", "--track", name, "--in", String((await schedule(track, now)).lead)]);

    default:
      return false;
  }
}

async function main() {
  const provider = new JsonRpcProvider(CFG.rpc);
  const pot = new Contract(CFG.pool, ABI, provider);

  log("MegaPot keeper starting");
  log("  pool     ", CFG.pool);
  log("  keeper   ", await pot.keeper());
  log("  tracks   ", CFG.tracks.map((t) => TRACK[t] ?? t).join(", "));
  log("  schedule ", CFG.jackpot ? `derived from Megapot ${CFG.jackpot}` : "ROUND_SECONDS/CLAIM_SECONDS (no JACKPOT set)");
  log("  poll     ", `${CFG.pollSeconds}s`, CFG.dryRun ? "(DRY RUN — sends nothing)" : "");

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log(`${sig} — finishing this tick, then exiting`);
      stopping = true;
    });
  }

  while (!stopping) {
    for (const track of CFG.tracks) {
      if (stopping) break;
      try {
        await tick(pot, provider, track);
      } catch (e) {
        // A read failed — almost always a throttled public endpoint. Next tick will retry.
        log(`[${TRACK[track] ?? track}] read failed:`, String(e.shortMessage || e.message).slice(0, 160));
      }
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, CFG.pollSeconds * 1000));
  }

  log("stopped cleanly");
  process.exit(0);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
