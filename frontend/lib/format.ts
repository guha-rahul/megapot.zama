export const USDC_DECIMALS = 6;

export function formatUsdc(value: bigint | undefined, digits = 2): string {
  if (value === undefined) return "—";
  const units = Number(value) / 10 ** USDC_DECIMALS;
  return units.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
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
  return `${((Number(tickets) / Number(total)) * 100).toFixed(2)}%`;
}

export function formatCountdown(target: number): string {
  const secs = target - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "now";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${secs % 60}s`;
}

export const shortAddress = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
