/**
 * Static export is opt-in via STATIC_EXPORT=1, which is how the Cloudflare Pages build runs.
 *
 * Every route here is a client component with no server work, so the export is lossless. What it
 * does drop is `headers()` below — Next cannot serve headers it is not running to serve — so the
 * same COOP/COEP pair is duplicated in `public/_headers` for Pages to apply. Both must stay in
 * step: without them TFHE has no SharedArrayBuffer and silently falls back to single-threaded.
 */
const staticExport = process.env.STATIC_EXPORT === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(staticExport ? { output: "export", images: { unoptimized: true } } : {}),
  webpack: (config) => {
    // The relayer SDK ships TFHE as WebAssembly and pulls in a few Node-only shims.
    config.experiments = { ...config.experiments, asyncWebAssembly: true, layers: true };
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, crypto: false };
    return config;
  },
  async headers() {
    // TFHE's threaded WASM needs SharedArrayBuffer, which browsers gate behind cross-origin
    // isolation. Everything this app loads is same-origin, so require-corp is safe here.
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
