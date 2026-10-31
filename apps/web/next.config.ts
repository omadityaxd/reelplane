import type { NextConfig } from "next";

const config: NextConfig = {
  // Internal workspace packages ship TypeScript source.
  transpilePackages: ["@reelplane/db", "@reelplane/storage"],
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  typescript: {
    // Type-checking runs separately via `pnpm typecheck` (TypeScript 7).
    ignoreBuildErrors: true,
  },
};

export default config;
