"use client";

/**
 * A viewer-supplied RPC endpoint.
 *
 * `NEXT_PUBLIC_RPC_URL` is inlined at build time, so the only person who can fix a throttled
 * endpoint is whoever can redeploy. That is the wrong shape for a public app: the person actually
 * being rate-limited is the one who cannot do anything about it.
 *
 * So the endpoint can also be set at runtime and kept in this browser. It is read once when the
 * wagmi config is built, which is why setting one reloads the page — recreating a live config
 * mid-session would invalidate every in-flight query for no real benefit.
 *
 * Stored per-browser and never sent anywhere. A keyed URL is a credential, so it stays local: not
 * put in a query string, not logged, not shared with the pool or with Zama.
 */
const KEY = "megapot.rpc";
const BASE_KEY = "megapot.rpc.base";

/** localStorage throws outright in some embedded contexts, so every access is guarded. */
function read(key: string): string | undefined {
  try {
    const v = window.localStorage.getItem(key);
    return v && isUsable(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Only https endpoints — a wallet-facing app should not downgrade to plaintext. */
export function isUsable(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export const customRpc = () => (typeof window === "undefined" ? undefined : read(KEY));
export const customBaseRpc = () => (typeof window === "undefined" ? undefined : read(BASE_KEY));

export function setCustomRpc(url: string | null, chain: "pool" | "base" = "pool") {
  const key = chain === "base" ? BASE_KEY : KEY;
  try {
    if (url) window.localStorage.setItem(key, url);
    else window.localStorage.removeItem(key);
  } catch {
    // A browser refusing storage is a reason to fail quietly, not to break the page.
  }
}
