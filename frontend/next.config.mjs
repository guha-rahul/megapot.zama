/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
