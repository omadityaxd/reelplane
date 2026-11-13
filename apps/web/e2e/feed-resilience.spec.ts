import { expect, test } from "@playwright/test";

/**
 * The first feed page, fetched by the browser (the /bench page has no server-rendered page),
 * survives a flaky network: failed requests are retried with backoff, and once the retries run
 * out the feed offers "Try again" instead of staying empty.
 */
const FEED = "**/v1/feeds/latest?*";

test("a first page lost to the network is retried until it loads", async ({ page }) => {
  let failures = 2;
  await page.route(FEED, (route) => (failures-- > 0 ? route.abort("failed") : route.continue()));
  await page.goto("/bench?swipes=1");
  await expect(page.locator(".rp-item").first()).toBeAttached({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});

test("after its retries the feed offers Try again, which loads it", async ({ page }) => {
  let down = true;
  let requests = 0;
  await page.route(FEED, (route) => {
    requests += 1;
    return down
      ? route.fulfill({ status: 503, json: { error: { message: "Down for a moment" } } })
      : route.continue();
  });
  await page.goto("/bench?swipes=1");

  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("alert").filter({ hasText: "Down for a moment" })).toBeVisible();
  expect(requests).toBe(4); // the first try and 3 automatic retries

  down = false;
  await retry.click();
  await expect(page.locator(".rp-item").first()).toBeAttached();
  await expect(retry).toHaveCount(0);
});
