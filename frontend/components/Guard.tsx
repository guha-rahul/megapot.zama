"use client";

import Link from "next/link";

import type { Eta } from "../lib/timing";
import { humanDuration, progress } from "../lib/timing";
import type { Journey, StepKey } from "../lib/useJourney";
import { useNow } from "../lib/usePool";

/**
 * Refuses politely instead of failing loudly.
 *
 * Each depositor route can be deep-linked. Rather than rendering a page whose buttons revert, the
 * guard names the missing prerequisite and links straight to the page that fixes it.
 */
export function Guard({
  journey,
  need,
  children,
}: {
  journey: Journey;
  need: StepKey;
  children: React.ReactNode;
}) {
  const blocker = journey.blocker(need);
  if (!blocker) return <>{children}</>;

  return (
    <div className="card">
      <div className="guard">
        <div className="guard-icon">🔒</div>
        <h2>One step first</h2>
        <p>{blocker.reason}</p>
        <Link href={blocker.href}>
          <button className="primary">{blocker.cta} →</button>
        </Link>
      </div>
    </div>
  );
}

/** How long a step takes, and the reason it takes that long. */
export function EtaBadge({ eta, showWhy = false }: { eta: Eta; showWhy?: boolean }) {
  return (
    <>
      <span className="eta" title={eta.because}>
        <ClockIcon />
        {eta.label}
      </span>
      {showWhy && <div className="eta-why">{eta.because}</div>}
    </>
  );
}

/** A live countdown to a deadline, with a progress bar when a start point is known. */
export function Countdown({
  to,
  from,
  label,
  done = "now",
}: {
  to: number;
  from?: number;
  label?: string;
  done?: string;
}) {
  const now = useNow();
  const remaining = to - now;
  return (
    <div>
      {label && <div className="stat-k">{label}</div>}
      <div className="stat-v num">{remaining <= 0 ? done : humanDuration(remaining)}</div>
      {from !== undefined && remaining > 0 && (
        <div className="bar">
          <div className="bar-fill" style={{ width: `${progress(from, to, now) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

function ClockIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
      <circle cx="6" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 3.6V6l1.8 1.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
