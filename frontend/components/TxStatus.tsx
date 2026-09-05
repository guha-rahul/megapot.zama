"use client";

import { explorerLink } from "../lib/contracts";
import type { TxState } from "../lib/useTx";
import { poolChain } from "../lib/wagmi";

export function TxStatus({ state, chainId = poolChain.id }: { state: TxState; chainId?: number }) {
  if (!state) return null;
  const cls = state.kind === "error" ? "status-error" : state.kind === "win" ? "status-win" : "";
  return (
    <div className={`status ${cls}`}>
      {state.busy && <span className="spinner" />}
      <span>
        {state.text}
        {state.hash && (
          <>
            {" · "}
            <a
              href={explorerLink(chainId, state.hash, "tx")}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--text)", borderBottom: "1px solid var(--line-strong)" }}
            >
              view ↗
            </a>
          </>
        )}
      </span>
    </div>
  );
}

/** A labelled amount input with an optional Max. */
export function AmountField({
  value,
  onChange,
  unit,
  max,
  maxLabel = "Available",
  format,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  unit: string;
  max?: bigint;
  maxLabel?: string;
  format: (v: bigint | undefined) => string;
  /** Why this amount cannot be submitted — see `checkAmount`. */
  error?: string | null;
}) {
  return (
    <>
      <div className="field" data-invalid={Boolean(error)}>
        <input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="0.00"
          aria-label={`Amount in ${unit}`}
        />
        <span className="field-suffix">{unit}</span>
      </div>
      <div className="field-meta">
        <span>
          {maxLabel} <span className="num">{max === undefined ? "—" : format(max)}</span>
        </span>
        {max !== undefined && max > 0n && (
          <button className="link-btn" onClick={() => onChange(format(max).replace(/,/g, ""))}>
            Max
          </button>
        )}
      </div>
      {error && <div className="field-error">{error}</div>}
    </>
  );
}
