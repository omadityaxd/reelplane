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
    launchOptions: {
      args: [
        "--autoplay-policy=no-user-gesture-required",
        // A fake audio output: with sound on, Chrome times playback by the audio device, and a
        // flaky one (measured on the dev laptop: a plain unmuted <video> ran at ~80% speed and
        // the feed froze in 9 of 10 runs, 10 of 10 fine with this flag) makes tests measure the
        // speaker instead of the player. Elements are still muted/unmuted as in a real browser.
        "--disable-audio-output",
      ],
    },
  },
});
