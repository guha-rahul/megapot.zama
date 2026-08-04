"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";

import { shortAddress } from "../lib/format";
import { activeChain } from "../lib/wagmi";

export function ConnectButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  if (!isConnected) {
    const wallet = connectors[0];
    if (!wallet) return <span className="pill">No wallet detected</span>;
    return (
      <button className="primary" disabled={isPending} onClick={() => connect({ connector: wallet })}>
        {isPending ? "Connecting…" : `Connect ${wallet.name}`}
      </button>
    );
  }

  if (chainId !== activeChain.id) {
    return (
      <button className="primary" onClick={() => switchChain({ chainId: activeChain.id })}>
        Switch to {activeChain.name}
      </button>
    );
  }

  return (
    <button onClick={() => disconnect()} title={address}>
      {shortAddress(address)}
    </button>
  );
}
