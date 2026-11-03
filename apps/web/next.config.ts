import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// One .env at the repo root configures everything (scripts, worker, web). Next reads only
// apps/web/.env*, so load the root file too. Real environment variables and apps/web/.env.local
// still win: loadEnvFile never overrides a variable that is already set.
const rootEnv = resolve(import.meta.dirname, "..", "..", ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

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
