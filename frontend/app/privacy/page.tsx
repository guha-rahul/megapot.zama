"use client";

import { PrivacyTable } from "../../components/Explainer";
import { Shell } from "../../components/Shell";
import { usePrivateState, usePublicState } from "../../lib/usePool";
import { useJourney } from "../../lib/useJourney";

/** What is encrypted, what is revealed, and what never decrypts for anyone. */
export default function PrivacyPage() {
  const pool = usePublicState();
  const me = usePrivateState();
  const journey = useJourney(me, pool);

  const reveals: [string, string, string][] = [
    ["Closing a round", "The pool's total stake", "A draw needs a plaintext modulus, and the principal sits in a public venue anyway. Deposits between two closes hide inside the batch."],
    ["Deploying to yield", "The batch aggregate awaiting deployment", "The sum, never its composition."],
    ["Sweeping a round", "Whether the prize was claimed", "Never by whom. The anonymity set is everyone who claimed — which is why claiming is cheap and rational for all."],
  ];

  return (
    <Shell pool={pool} journey={journey} showRail={false}>
      <div className="page-head">
        <div className="eyebrow">Transparency</div>
        <h1>What&apos;s encrypted</h1>
        <p>
          Pool-wide aggregates are public by necessity — the money sits in a real yield venue and a
          real lottery, where its size is visible regardless. Every <em>per-user</em> quantity is not.
        </p>
      </div>

      <PrivacyTable />

      <div className="card">
        <div className="card-head">
          <h2>The three moments something becomes public</h2>
        </div>
        <p className="card-hint">
          Every plaintext this protocol ever produces, and the reason each one is unavoidable.
        </p>
        {reveals.map(([when, what, why]) => (
          <div key={when} style={{ padding: "13px 0", borderBottom: "1px solid var(--line)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 13.5 }}>{when}</strong>
              <span className="chip chip-gold">{what}</span>
            </div>
            <p className="card-hint" style={{ margin: "7px 0 0" }}>{why}</p>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Never decrypted, by anyone</h2>
          <span className="chip">no key path exists</span>
        </div>
        <p className="card-hint">
          These handles receive <code className="mono">FHE.allowThis</code> and nothing else. The
          contract can compute on them homomorphically; no party — you, the keeper, governance, or
          Zama — can ever read them.
        </p>
        {["The winning ticket", "Every hit/miss boolean in a claim", "The live ticket cursor", "Who won"].map((x) => (
          <div className="row" key={x}>
            <span className="row-k">{x}</span>
            <span className="row-v"><span className="cipher">sealed</span></span>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>What still leaks</h2>
        </div>
        <p className="card-hint" style={{ margin: 0 }}>
          Amounts are hidden; <strong>participation and timing are not</strong>. That address X
          deposited, claimed or withdrew at time T is public. A pool with one depositor has no
          anonymity set at all, and correlation over time is a real attack on a thin pool. Claim gas
          also scales with how many ticket ranges you hold — never with whether you won.
        </p>
      </div>
    </Shell>
  );
}
