import { expect, test } from "@playwright/test";

interface Sample {
  attempt: number;
  index: number;
  swipeToPlayMs: number | null;
  visibleMs: number | null;
  flagged: boolean;
  why: { hiddenAtSwipe: boolean; hiddenMs: number; playOutcome: string } | null;
}

/**
 * /bench explains slow swipes: a swipe made while the page was hidden (an app switch, as in the
 * first iPhone run) is flagged and its hidden time left out, and every swipe records what its
 * play() did. The app switch is simulated: document.hidden is overridden and the event fired.
 */
test("/bench flags a swipe made while the page was hidden and records play()", async ({ page }) => {
  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    const setHidden = (value: boolean) => {
      hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
    };
    // Swipe 2 comes 500 ms after swipe 1 is recorded, swipe 3 about 550 ms after that: "switch
    // apps" right then for 800 ms, so swipe 2 happens while hidden and swipe 3 while visible.
    const watch = setInterval(() => {
      const bench = (window as { __reelplaneBench?: { samples: unknown[] } }).__reelplaneBench;
      if ((bench?.samples.length ?? 0) < 1) return;
      clearInterval(watch);
      setHidden(true);
      setTimeout(() => setHidden(false), 800);
    }, 20);
  });
  await page.goto("/bench?swipes=3&dwell=500");

  await page.waitForFunction(
    () => (window as { __reelplaneBench?: { done: boolean } }).__reelplaneBench?.done === true,
    undefined,
    { timeout: 30_000 },
  );
  const result = (await page.evaluate(
    () => (window as { __reelplaneBench?: unknown }).__reelplaneBench,
  )) as { samples: Sample[]; flagged: number; clean: { n: number } };

  // One row per attempt, numbered in order (a retried target no longer looks like a duplicate).
  expect(result.samples.map((s) => s.attempt)).toEqual([1, 2, 3]);
  const [first, second, third] = result.samples;
  expect(second?.flagged).toBe(true);
  expect(second?.why?.hiddenAtSwipe).toBe(true);
  expect(second?.visibleMs).toBe((second?.swipeToPlayMs ?? 0) - (second?.why?.hiddenMs ?? 0));
  for (const clean of [first, third]) {
    expect(clean?.flagged).toBe(false);
    expect(clean?.why?.playOutcome).toBe("resolved");
  }
  expect(result.flagged).toBe(1);
  expect(result.clean.n).toBe(2);
  await expect(page.locator("#bench-status")).toContainText("flagged 1");
});
