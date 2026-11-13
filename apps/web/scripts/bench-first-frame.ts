/**
 * First-video time to first frame, measured like a viewer opening the app: every run is a fresh
 * browser context (cold HTTP cache, a per-run nonce on media URLs) on an emulated phone under
 * Chrome's "Fast 4G" throttle, loading /bench and reading its first-video timings.
 *
 *   pnpm --filter @reelplane/web bench:first-frame [runs=10] [label] [baseUrl]
 *
 * Needs the production build running (`next start`) and the bench videos seeded (`pnpm bench:seed`).
 * Writes docs/benchmarks/first-frame-<label>.json.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const [runsArg = "10", label = "run", baseUrl = "http://localhost:3000"] = process.argv.slice(2);
const runs = Number(runsArg);

/** Chrome DevTools' "Fast 4G" preset (as in Puppeteer's PredefinedNetworkConditions). */
const FAST_4G = {
  offline: false,
  downloadThroughput: (9 * 1000 * 1000 * 0.9) / 8,
  uploadThroughput: (1.5 * 1000 * 1000 * 0.9) / 8,
  latency: 60 * 2.75,
};

interface Sample {
  run: number;
  activationToFirstFrameMs: number;
  navigationToFirstFrameMs: number;
  playlistRequests: number;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--autoplay-policy=no-user-gesture-required", "--disable-audio-output"],
});
const samples: Sample[] = [];
try {
  for (let run = 1; run <= runs; run += 1) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", FAST_4G);
    let playlistRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith(".m3u8")) playlistRequests += 1;
    });
    await page.goto(`${baseUrl}/bench?swipes=1&run=${label}-${run}-${Date.now()}`);
    const timing = await page.waitForFunction(
      () => {
        const bench = (window as { __reelplaneBench?: Record<string, number | null> })
          .__reelplaneBench;
        return bench?.initialTtffMs != null && bench.pageLoadToFirstFrameMs != null
          ? { ttff: bench.initialTtffMs, page: bench.pageLoadToFirstFrameMs }
          : null;
      },
      undefined,
      { timeout: 60_000 },
    );
    const { ttff, page: fromNavigation } = (await timing.jsonValue()) as {
      ttff: number;
      page: number;
    };
    samples.push({
      run,
      activationToFirstFrameMs: ttff,
      navigationToFirstFrameMs: fromNavigation,
      // Counted until the first frame: the first video's playlists (and maybe a preload's).
      playlistRequests,
    });
    process.stdout.write(
      `run ${run}: activation→frame ${ttff} ms, navigation→frame ${fromNavigation} ms\n`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}

const summary = (key: "activationToFirstFrameMs" | "navigationToFirstFrameMs") => {
  const values = samples.map((s) => s[key]);
  return { p50: percentile(values, 50), p95: percentile(values, 95) };
};
const result = {
  label,
  measuredAt: new Date().toISOString(),
  network: "Chrome DevTools Fast 4G (9 Mbps down ×0.9, 1.5 Mbps up ×0.9, 165 ms latency)",
  device: "390x844 @3x, touch, Chrome",
  runs,
  activationToFirstFrame: summary("activationToFirstFrameMs"),
  navigationToFirstFrame: summary("navigationToFirstFrameMs"),
  samples,
};
const target = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "docs",
  "benchmarks",
  `first-frame-${label}.json`,
);
writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(
  `\n${label}: activation→first frame p50 ${result.activationToFirstFrame.p50} ms, p95 ${result.activationToFirstFrame.p95} ms; ` +
    `navigation→first frame p50 ${result.navigationToFirstFrame.p50} ms, p95 ${result.navigationToFirstFrame.p95} ms\n` +
    `Wrote ${target}\n`,
);
