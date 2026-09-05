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

/** Turn a wallet/RPC error into one readable line. */
export function readableError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/user rejected|User denied|ACTION_REJECTED/i.test(raw)) return "Rejected in wallet.";
  if (/insufficient funds/i.test(raw)) return "Not enough ETH for gas on this network.";
  const custom = raw.match(/reverted with custom error '([^']+)'/);
  if (custom) return `Reverted: ${custom[1]}`;
  const reason = raw.match(/reason="([^"]+)"/) ?? raw.match(/reverted with reason string '([^']+)'/);
  if (reason) return `Reverted: ${reason[1]}`;
  return raw.split("\n")[0].slice(0, 220);
}
