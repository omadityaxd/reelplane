import { expect, type Page, test } from "@playwright/test";

/**
 * The production build sends the security headers, and its Content-Security-Policy blocks
 * nothing the pages need: the feed plays (hls.js, MediaSource, storage), and the other pages
 * load without a single violation.
 */
async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as { __cspViolations?: string[] }).__cspViolations ?? []);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as { __cspViolations?: string[] }).__cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.effectiveDirective} blocked ${event.blockedURI || "inline"}`);
    });
  });
});

test("the site sends the security headers", async ({ page }) => {
  const response = await page.goto("/");
  const headers = response?.headers() ?? {};
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["strict-transport-security"]).toContain("max-age=");
  expect(headers["x-powered-by"]).toBeUndefined();
});

test("the feed plays and swipes under the policy", async ({ page }) => {
  await page.goto("/bench?swipes=3&dwell=300");
  await page.waitForFunction(
    () => (window as { __reelplaneBench?: { done?: boolean } }).__reelplaneBench?.done === true,
    undefined,
    { timeout: 45_000 },
  );
  const played = await page.evaluate(() =>
    [...document.querySelectorAll("video")].some((video) => video.played.length > 0),
  );
  expect(played).toBe(true);
  expect(await violations(page)).toEqual([]);
});

for (const path of ["/", "/login", "/upload", "/developers", "/developers/api"]) {
  test(`${path} loads without a policy violation`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(await violations(page)).toEqual([]);
  });
}
