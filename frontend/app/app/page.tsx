"use client";

import { ActionPanel } from "../components/ActionPanel";
import { ConnectButton } from "../components/ConnectButton";
import { PoolHero } from "../components/PoolHero";
import { YourPosition } from "../components/YourPosition";
import { isConfigured } from "../lib/contracts";
import { usePrivateState, usePublicState } from "../lib/usePool";

export default function Home() {
  const pool = usePublicState();
  const me = usePrivateState();

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <h1>MegaPot</h1>
          <span>confidential no-loss lottery · Zama Protocol</span>
        </div>
        <ConnectButton />
      </header>

      {!isConfigured() ? (
        <NotConfigured />
      ) : (
        <>
          <PoolHero pool={pool} />
          <div className="grid">
            <ActionPanel me={me} pool={pool} />
            <YourPosition me={me} pool={pool} />
          </div>
        </>
      )}

      <footer className="note">
        Prizes come from yield only — your principal is never spent on a draw. Pool-wide totals are
        public because the money sits in a real yield venue; every per-user quantity is encrypted.
        Unaudited software, testnet only.
      </footer>
    </main>
  );
}

function NotConfigured() {
  return (
    <div className="card">
      <h2>Point the app at a deployment</h2>
      <p className="hint">Copy <code>.env.local.example</code> to <code>.env.local</code> and fill it in.</p>
      <ol className="steps">
        <li>
          <code>npx hardhat megapot:deploy --network sepolia</code>
        </li>
        <li>
          Copy the addresses from <code>deployments/sepolia.json</code> into <code>.env.local</code>
        </li>
        <li>
          <code>npm run dev</code>
        </li>
      </ol>
    </div>
  );
}
