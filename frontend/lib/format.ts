export const USDC_DECIMALS = 6;

export function formatUsdc(value: bigint | undefined, digits = 2): string {
  if (value === undefined) return "—";
  const units = Number(value) / 10 ** USDC_DECIMALS;
  return units.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Compact form for headline figures: 1.2K, 3.4M. */
export function formatCompact(value: bigint | undefined): string {
  if (value === undefined) return "—";
  const units = Number(value) / 10 ** USDC_DECIMALS;
  if (units >= 1000)
    return units.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 });
  return units.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function parseUsdc(input: string): bigint {
  const trimmed = input.trim();
  if (!trimmed || Number.isNaN(Number(trimmed))) return 0n;
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt(padded || "0");
}

export function formatOdds(tickets: bigint | undefined, total: bigint | undefined): string {
  if (tickets === undefined || !total) return "—";
  const pct = (Number(tickets) / Number(total)) * 100;
  if (pct > 0 && pct < 0.01) return "<0.01%";
  return `${pct.toFixed(2)}%`;
}

export function formatCountdown(target: number, now = Math.floor(Date.now() / 1000)): string {
  const secs = target - now;
  if (secs <= 0) return "now";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export const shortAddress = (a?: string, size = 4) =>
  a ? `${a.slice(0, 2 + size)}…${a.slice(-size)}` : "";

/** A ciphertext handle, shortened for display. It is meant to look opaque. */
export const shortHandle = (h?: string) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "");

/**
 * What each of the contract's reverts means, in words a depositor can act on.
 *
 * The generated ABI carries the contracts' `error` entries, so viem now hands us the error name
 * structurally rather than buried in a message string. A name is not an explanation, though —
 * `AlreadyCompactedThisRound` tells you nothing unless you have read the contract.
 */
const REVERTS: Record<string, string> = {
  // MegaPot
  DepositsPaused: "Deposits are paused right now. Withdrawals still work.",
  AlreadyClaimed: "You have already claimed this round.",
  WrongState: "The round is not at a stage that allows this yet.",
  TooEarly: "Not yet — the draw time has not passed.",
  AlreadyCompactedThisRound:
    "You have already reshaped your tickets this round. Wait for the next one — the limit is what stops the ticket space being inflated.",
  AmountTooLarge: "That is larger than a 64-bit encrypted value can hold.",
  InvalidAllocation: "Pick a whole percentage between 0 and 100 that differs from your current one.",
  UnsupportedToken: "This pool cannot account for that token.",
  AssetMismatch: "That venue is denominated in a different token from the pool.",
  YieldSourceNotSet: "No yield venue is wired on this deployment.",
  BufferFull: "The withdrawal buffer is already at its target.",
  NoYield: "There is no surplus to harvest yet.",
  OnlyKeeper: "Only the pool's keeper or owner can do that.",
  UnknownTrack: "That prize track does not exist.",
  // ERC-7984 / ConfidentialUSDC
  ERC7984UnauthorizedSpender: "The pool is not authorised to move your cUSDC yet — finish setup first.",
  ERC7984UnauthorizedUseOfEncryptedAmount:
    "That encrypted amount was not built for this contract and your address, so it cannot be replayed here.",
  SafeERC20FailedOperation: "That token transfer failed. Check you are using the USDC this pool accepts.",
};

/** Turn a wallet/RPC error into one readable line. */
export function readableError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/user rejected|User denied|ACTION_REJECTED/i.test(raw)) return "Rejected in wallet.";
  if (/insufficient funds/i.test(raw)) return "Not enough ETH for gas on this network.";
  if (/chain mismatch|ChainMismatch/i.test(raw)) return "Your wallet is on the wrong network — switch to Sepolia.";

  // viem puts the decoded name in the message once the ABI carries error entries.
  for (const [name, explanation] of Object.entries(REVERTS)) {
    if (raw.includes(name)) return explanation;
  }

  const custom = raw.match(/reverted with custom error '([^']+)'/);
  if (custom) return `Reverted: ${custom[1]}`;
  const reason = raw.match(/reason="([^"]+)"/) ?? raw.match(/reverted with reason string '([^']+)'/);
  if (reason) return `Reverted: ${reason[1]}`;
  return raw.split("\n")[0].slice(0, 220);
}

/** The largest value an `euint64` can carry. */
const UINT64_MAX = 2n ** 64n - 1n;

/**
 * Why an amount cannot be submitted, or null if it can.
 *
 * `max` is optional because the balance it would check against is encrypted: until the user
 * decrypts, this app genuinely does not know it. That is not a reason to block them — the
 * contract caps every move at what they actually hold — so an unknown maximum simply skips that
 * check rather than guessing.
 */
export function checkAmount(value: bigint, max: bigint | undefined, unit: string): string | null {
  if (value <= 0n) return "Enter an amount.";
  if (value > UINT64_MAX) return "That is larger than a 64-bit encrypted value can hold.";
  if (max !== undefined && value > max) {
    return `You only have ${formatUsdc(max)} ${unit}. Asking for more moves only what you hold — silently.`;
  }
  return null;
}
