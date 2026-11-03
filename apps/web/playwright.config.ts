import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

// Tests that talk to Supabase or the database read the same root .env as the app.
const rootEnv = resolve(import.meta.dirname, "..", "..", ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/**
 * End-to-end playback tests. They need the running stack (`pnpm infra:up`, the worker, a seeded
 * demo: `pnpm showcase:seed`) and the web app (`next start`). Run: `pnpm --filter @reelplane/web e2e`.
 *
 * They use the installed Google Chrome (`channel: "chrome"`): Playwright's bundled Chromium has
 * no H.264/AAC, so it cannot play the renditions at all.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    channel: "chrome",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
});
