import type { NextConfig } from "next";

// Lets a phone on the same network load the dev server (Next blocks cross-origin dev requests).
const lanHosts = (process.env.NEXT_DEV_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

const config: NextConfig = {
  // Internal workspace packages ship TypeScript source.
  transpilePackages: [
    "@reelplane/db",
    "@reelplane/storage",
    "@reelplane/sdk-core",
    "@reelplane/sdk-react",
  ],
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  allowedDevOrigins: lanHosts,
  typescript: {
    // Type-checking runs separately via `pnpm typecheck` (TypeScript 7).
    ignoreBuildErrors: true,
  },
};

export default config;
