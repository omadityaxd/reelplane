import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createPool, resolveDatabaseUrl } from "@reelplane/db";
import { testUserFor } from "../lib/server/dashboard/test-auth.ts";

/**
 * The dashboard's main flow, end to end: sign in, create a project, upload a video from the
 * browser straight to storage, and watch the worker turn it into a playable HLS ladder.
 *
 * Needs the app in test mode (REELPLANE_TEST_AUTH=1), the Docker infra, FFmpeg and a running
 * worker (`pnpm worker:dev`). Skipped, with the reason, when any of those is missing.
 */
const login = `uploader-${randomUUID().slice(0, 6)}`;
/** A worker that hasn't recorded its presence for this long is not running. */
const WORKER_FRESH_SECONDS = 120;

test.beforeAll(async ({ request }) => {
  const consent = await request.get("/auth/test-github");
  test.skip(consent.status() !== 200, "the app is not running with REELPLANE_TEST_AUTH=1");
  const pool = createPool(resolveDatabaseUrl(), { max: 1 });
  try {
    const { rows } = await pool.query<{ fresh: boolean | null }>(
      "select now() - reelplane.worker_last_seen() < make_interval(secs => $1) as fresh",
      [WORKER_FRESH_SECONDS],
    );
    test.skip(rows[0]?.fresh !== true, "no worker is running (start one: pnpm worker:dev)");
  } finally {
    await pool.end();
  }
});

test.afterAll(async () => {
  const pool = createPool(resolveDatabaseUrl(), { max: 1 });
  try {
    await pool.query("delete from reelplane.projects where owner_id = $1", [testUserFor(login).id]);
  } finally {
    await pool.end();
  }
});

test("upload from the dashboard → transcoded by the worker → ready and playable", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  // A real 4 s portrait clip with sound, made on the spot (no binary fixtures in the repo).
  const clip = testInfo.outputPath("dashboard-upload.mp4");
  execFileSync("ffmpeg", [
    ...["-hide_banner", "-nostdin", "-y", "-v", "error"],
    ...["-f", "lavfi", "-i", "testsrc2=size=540x960:rate=30:duration=4"],
    ...["-f", "lavfi", "-i", "sine=frequency=440:duration=4"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac"],
    ...["-shortest", "-movflags", "+faststart", clip],
  ]);

  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await page.getByLabel("GitHub login").fill(login);
  await page.getByRole("button", { name: "Authorize" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.getByPlaceholder("New project name").fill("Upload e2e");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("link", { name: "Open the project →" }).click();
  await expect(page).toHaveURL(/\/dashboard\/[0-9a-f-]{36}$/);

  // The upload goes from the browser to storage; then the app opens the video's page.
  await page.locator('input[type="file"]').setInputFiles(clip);
  await expect(page).toHaveURL(/\/videos\/[0-9a-f-]{36}$/, { timeout: 30_000 });

  // The page refreshes itself while the video is queued or processing.
  const status = page.locator(".dash-badge", { hasText: /^ready$/ });
  await expect(status.first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("heading", { name: "Renditions" })).toBeVisible();
  // 540x960 source: 240p and 480p (540 is too close to 480 for a native rung of its own).
  await expect(page.getByRole("cell", { name: "240×426" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "480×854" })).toBeVisible();

  // The preview actually plays the published HLS.
  const video = page.locator("video");
  await video.evaluate((element: HTMLVideoElement) => {
    element.muted = true;
    return element.play();
  });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), {
      timeout: 15_000,
    })
    .toBeGreaterThan(1);
});
