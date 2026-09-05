/**
 * How long things take, and why.
 *
 * Several steps here are not instant, and the waits have very different causes — a block, a
 * threshold-decryption round trip, or Ethereum hard finality. Saying "pending…" for all three
 * teaches nobody anything; each of these is quoted with its reason.
 */
export type Eta = { label: string; seconds: number; because: string };

export const ETA = {
  tx: {
    label: "~15 sec",
    seconds: 15,
    because: "one Sepolia block, then a confirmation",
  },
  encrypt: {
    label: "2–10 sec",
    seconds: 10,
    because: "the TFHE bundle loads once, then encryption is local",
  },
  userDecrypt: {
    label: "~3 sec",
    seconds: 3,
    because: "the KMS re-encrypts to your ephemeral key; the plaintext never leaves this tab",
  },
  publicDecrypt: {
    label: "~10 sec",
    seconds: 10,
    because: "a threshold of KMS nodes must sign the cleartext before it can go on-chain",
  },
  cctp: {
    label: "13–19 min",
    seconds: 16 * 60,
    because: "Circle attests only after hard finality on Ethereum — roughly 2 epochs",
  },
  megapotRound: {
    label: "5 min",
    seconds: 300,
    because: "Megapot's Base Sepolia round duration",
  },
} as const satisfies Record<string, Eta>;

/** A short human string for a duration in seconds. */
export function humanDuration(secs: number): string {
  if (secs <= 0) return "now";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Fraction elapsed between two timestamps, clamped — for progress bars. */
export function progress(startSec: number, endSec: number, nowSec: number): number {
  if (endSec <= startSec) return 1;
  return Math.min(1, Math.max(0, (nowSec - startSec) / (endSec - startSec)));
}
