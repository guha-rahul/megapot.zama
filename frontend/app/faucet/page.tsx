"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccount, useBalance, useReadContracts, useWalletClient } from "wagmi";

import { Shell } from "../../components/Shell";
import { BASE_SEPOLIA_ID, addresses, chainId, explorerLink, usdcDripAbi } from "../../lib/contracts";
import { formatUsdc } from "../../lib/format";
import { humanDuration } from "../../lib/timing";
import { usePrivateState, usePublicState } from "../../lib/usePool";
import { useTx } from "../../lib/useTx";
import { TxStatus } from "../../components/TxStatus";
import { poolChain } from "../../lib/wagmi";

/**
 * Everything a fresh wallet needs, on one page, before it touches the pool.
 *
 * This exists because the first thing that happens to a new visitor is a dead end: the pool takes
 * exactly one token, that token is free but not obvious to find, and the faucet that mints it asks
 * for an address the visitor then has to go dig out of their wallet. Each step is trivial and the
 * sequence is not, so the sequence is the page — with live balances, so "do I still need this?" is
 * answered by the page rather than guessed at.
 */
export default function FaucetPage() {
  const pool = usePublicState();
  const me = usePrivateState();
  const { address, isConnected } = useAccount();

  const gas = useBalance({ address, chainId: poolChain.id });
  const baseGas = useBalance({ address, chainId: BASE_SEPOLIA_ID });

  const hasGas = (gas.data?.value ?? 0n) > 0n;
  const hasUsdc = (me.usdcBalance ?? 0n) > 0n;
  const ready = hasGas && hasUsdc;

  return (
    <Shell pool={pool} showRail={false}>
      <div className="page-head">
        <div className="eyebrow">Before you start</div>
        <h1>Get test assets</h1>
        <p>
          Everything here is free and worth nothing. You need two things on Ethereum Sepolia — a
          little ETH for gas, and the one USDC the pool accepts. Three minutes, then you never come
          back to this page.
        </p>
      </div>

      <AddressCard address={address} isConnected={isConnected} />

      <Step
        n={1}
        title="Sepolia ETH — for gas"
        done={hasGas}
        hint="Encrypted calls cost more gas than ordinary ones. Anything from 0.05 ETH is plenty for a full run."
        have={gas.data ? `${Number(gas.data.formatted).toFixed(4)} ETH` : "—"}
        links={[
          ["Google Cloud faucet ↗", "https://cloud.google.com/application/web3/faucet/ethereum/sepolia"],
          ["sepoliafaucet.com ↗", "https://sepoliafaucet.com"],
        ]}
      />

      <Step
        n={2}
        title="Sepolia USDC — the pool's token"
        done={hasUsdc}
        hint="Pick Ethereum Sepolia in the faucet's network dropdown, not Base Sepolia. 10 USDC is more than enough."
        have={formatUsdc(me.usdcBalance)}
        links={[["Open Circle faucet ↗", "https://faucet.circle.com"]]}
      >
        <Drip onArrive={() => me.refetchHandles()} />
        <TokenRow />
      </Step>

      <Step
        n={3}
        title="Base Sepolia ETH — optional"
        done={(baseGas.data?.value ?? 0n) > 0n}
        hint="Only needed to view the Megapot leg on Base. The deposit, draw, claim and withdraw flow never asks you to switch networks."
        have={baseGas.data ? `${Number(baseGas.data.formatted).toFixed(4)} ETH` : "—"}
        links={[["Base Sepolia faucet ↗", "https://portal.cdp.coinbase.com/products/faucet"]]}
      />

      <div className="card">
        <div className="card-head">
          <h2>{ready ? "You're ready" : "Then head to setup"}</h2>
          {ready && <span className="chip chip-mint">both funded</span>}
        </div>
        <p className="card-hint">
          Next you wrap USDC into cUSDC — the confidential version — and let the pool move it. That
          is one transaction, and everything you do after it is encrypted.
        </p>
        <Link href="/setup">
          <button className="primary block" style={{ marginTop: 14 }}>
            Set up your confidential balance →
          </button>
        </Link>
      </div>
    </Shell>
  );
}

/** The address the faucets ask for, one click from the page that sends you to them. */
function AddressCard({ address, isConnected }: { address?: string; isConnected: boolean }) {
  const [copied, setCopied] = useState(false);

  if (!isConnected || !address)
    return (
      <div className="card">
        <div className="card-head">
          <h2>Connect first</h2>
          <span className="chip">needed</span>
        </div>
        <p className="card-hint">
          Every faucet below asks for an address. Connect a wallet and this page will show it, with
          a copy button, so you are not switching windows to find it.
        </p>
      </div>
    );

  return (
    <div className="card">
      <div className="card-head">
        <h2>Paste this into the faucets</h2>
        <span className="chip chip-mint">connected</span>
      </div>
      <div className="row">
        <span className="row-k">Your address</span>
        <span className="row-v num" style={{ wordBreak: "break-all" }}>
          {address}
        </span>
      </div>
      <button
        className="primary block"
        style={{ marginTop: 14 }}
        onClick={() => {
          void navigator.clipboard?.writeText(address).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            },
            () => undefined,
          );
        }}
      >
        {copied ? "Copied ✓" : "Copy address"}
      </button>
    </div>
  );
}

/**
 * The pool accepts exactly one USDC, and several things on Sepolia are called USDC. Naming the
 * right one here — with a button that adds it to the wallet — is cheaper than letting someone
 * deposit Aave's test token and discover the mistake from a revert.
 */
function TokenRow() {
  const { data: walletClient } = useWalletClient();
  const [added, setAdded] = useState(false);

  return (
    <>
      <div className="row">
        <span className="row-k">Token address</span>
        <a
          className="row-v num"
          style={{ wordBreak: "break-all" }}
          href={explorerLink(chainId, addresses.usdc)}
          target="_blank"
          rel="noreferrer"
        >
          {addresses.usdc}
        </a>
      </div>
      <p className="card-hint" style={{ marginTop: 10 }}>
        This is Circle&apos;s Sepolia USDC. Other tokens on Sepolia are also called
        &ldquo;USDC&rdquo; — Aave&apos;s test token in particular — and the pool rejects them.
      </p>
      <button
        className="block"
        style={{ marginTop: 10 }}
        disabled={!walletClient || added}
        onClick={() => {
          void walletClient
            ?.request({
              method: "wallet_watchAsset",
              params: {
                type: "ERC20",
                options: { address: addresses.usdc, symbol: "USDC", decimals: 6 },
              },
            } as never)
            .then(
              () => setAdded(true),
              () => undefined,
            );
        }}
      >
        {added ? "Added to wallet ✓" : "Add USDC to wallet"}
      </button>
    </>
  );
}

function Step({
  n,
  title,
  hint,
  have,
  done,
  links,
  children,
}: {
  n: number;
  title: string;
  hint: string;
  have: string;
  done: boolean;
  links: [string, string][];
  children?: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>
          {n} · {title}
        </h2>
        <span className={done ? "chip chip-mint" : "chip"}>{done ? "done" : "needed"}</span>
      </div>
      <p className="card-hint">{hint}</p>
      <div className="row">
        <span className="row-k">You have</span>
        <span className="row-v num">{have}</span>
      </div>
      {children}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
        {links.map(([label, href]) => (
          <a key={href} href={href} target="_blank" rel="noreferrer" style={{ flex: "1 1 200px" }}>
            <button className={done ? "block" : "primary block"}>{label}</button>
          </a>
        ))}
      </div>
    </div>
  );
}

/**
 * One-click USDC, without leaving the page.
 *
 * Circle's faucet is the only source of the token the pool accepts, and getting there costs a
 * visitor four steps — leave, find it, pick the right network, paste an address — with a wrong
 * token waiting at the end of the most likely mistake. So a small float of the *correct* token
 * sits in `UsdcDrip` and hands out a fixed amount per address.
 *
 * It is deliberately additive: the Circle link stays right below, because the drip is finite and
 * a visitor who arrives after it runs dry needs the real faucet, not an apology.
 */
function Drip({ onArrive }: { onArrive: () => void }) {
  const { address, isConnected } = useAccount();
  const { run, state, busy } = useTx();

  const configured = Boolean(addresses.usdcDrip);
  const { data, refetch } = useReadContracts({
    contracts: [
      { address: addresses.usdcDrip, abi: usdcDripAbi, functionName: "dripsLeft" },
      { address: addresses.usdcDrip, abi: usdcDripAbi, functionName: "amount" },
      {
        address: addresses.usdcDrip,
        abi: usdcDripAbi,
        functionName: "readyAt",
        args: address ? [address] : undefined,
      },
    ],
    query: { enabled: configured, refetchInterval: 20_000 },
  });

  if (!configured) return null;

  const left = (data?.[0]?.result as bigint | undefined) ?? 0n;
  const size = (data?.[1]?.result as bigint | undefined) ?? 0n;
  const readyAt = (data?.[2]?.result as bigint | undefined) ?? 0n;
  const cooling = readyAt > 0n;
  const dry = left === 0n;

  const claim = async () => {
    await run(
      `Sending you ${formatUsdc(size)} USDC`,
      async () => {
        const { getWalletClient } = await import("../../lib/clients");
        const wc = await getWalletClient();
        return wc.writeContract({
          address: addresses.usdcDrip,
          abi: usdcDripAbi,
          functionName: "claim",
          chain: poolChain,
          account: address!,
        });
      },
      async () => {
        void refetch();
        onArrive();
      },
    );
  };

  return (
    <div className="drip">
      <div className="row">
        <span className="row-k">One-click faucet</span>
        <span className="row-v num">
          {dry ? "empty" : `${String(left)} × ${formatUsdc(size)} USDC left`}
        </span>
      </div>
      <button
        className="primary block"
        style={{ marginTop: 12 }}
        disabled={!isConnected || busy || dry || cooling}
        onClick={claim}
      >
        {!isConnected
          ? "Connect a wallet first"
          : dry
            ? "Faucet is empty — use Circle's below"
            : cooling
              ? `Already claimed — try again in ${humanDuration(Number(readyAt) - Math.floor(Date.now() / 1000))}`
              : `Send me ${formatUsdc(size)} USDC`}
      </button>
      <p className="card-hint" style={{ marginTop: 10 }}>
        Holds a float of the exact token the pool accepts, so there is no network dropdown and no
        wrong-token trap. One drip per address every 12 hours. When it runs dry, Circle&apos;s
        faucet below is the real source.
      </p>
      <TxStatus state={state} />
    </div>
  );
}
