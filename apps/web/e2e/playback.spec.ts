import { expect, test } from "@playwright/test";

/**
 * Regression test for the iPhone bug "the first ~5 s play, then it buffers repeatedly":
 * the warmer played the unmuted next video every 4 s, and iOS (one audible media element at a
 * time) interrupted the active video. After swiping to a preloaded video with sound on,
 * playback must continue well past the preloaded part (~4 s) with no stalls or pauses, and
 * every other element must stay muted.
 */
test("a preloaded video keeps playing past its preloaded part after a swipe, with sound on", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".rp-item").first().waitFor();
  await page.waitForTimeout(4000); // let N+1 preload and get warmed at least once

  await page.getByRole("button", { name: "Unmute" }).click();
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".rp-scroller");
    scroller?.scrollBy({ top: scroller.clientHeight, behavior: "instant" });
  });

  const result = await page.evaluate(async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await wait(500);
    // The active slide's video, by index: "the one that isn't paused" could also be the next
    // video while the warmer plays its one-frame warm-up.
    const index = document
      .querySelector('.rp-item[aria-current="true"]')
      ?.getAttribute("data-index");
    const videos = [...document.querySelectorAll<HTMLVideoElement>("video.rp-video")];
    const active = videos.find((v) => v.dataset.index === index);
    if (!active || index !== "1") return { error: `active slide is ${index}, expected 1` };

    let stalls = 0;
    let pauses = 0;
    let mediaSeconds = 0;
    let last = active.currentTime;
    const startTime = active.currentTime;
    active.addEventListener("waiting", () => {
      if (!active.seeking) stalls += 1;
    });
    active.addEventListener("pause", () => {
      pauses += 1;
    });
    // Count media time played, including across a loop back to the start.
    for (let i = 0; i < 40; i += 1) {
      await wait(250);
      const now = active.currentTime;
      mediaSeconds += now >= last ? now - last : now;
      last = now;
    }
    const buffered = [...Array(active.buffered.length).keys()].map(
      (i) => `${active.buffered.start(i).toFixed(2)}-${active.buffered.end(i).toFixed(2)}`,
    );
    return {
      error: null,
      stalls,
      pauses,
      mediaSeconds,
      audible: !active.muted,
      othersMuted: videos.filter((v) => v !== active).every((v) => v.muted),
      // Diagnostics, printed when an assertion fails.
      startTime,
      endTime: active.currentTime,
      paused: active.paused,
      readyState: active.readyState,
      networkState: active.networkState,
      buffered,
      mediaError: active.error?.message ?? null,
      quality: active.getVideoPlaybackQuality?.(),
    };
  });

  const details = JSON.stringify(result);
  expect(result.error, details).toBeNull();
  expect(result.mediaSeconds, details).toBeGreaterThan(8); // well past the ~4 s preloaded part
  expect(result.stalls, details).toBe(0);
  expect(result.pauses, details).toBe(0);
  expect(result.audible).toBe(true);
  expect(result.othersMuted).toBe(true);
});
