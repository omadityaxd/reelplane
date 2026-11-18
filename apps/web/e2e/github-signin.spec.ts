import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { createPool, resolveDatabaseUrl } from "@reelplane/db";
import { testUserFor } from "../lib/server/dashboard/test-auth.ts";

/**
 * "Sign in with GitHub", end to end, without GitHub: run the app with REELPLANE_TEST_AUTH=1
 * (see docs/LAUNCH-CHECKLIST.md) and GitHub's consent screen is a local page. Skipped when the
 * server isn't in test mode.
 */
test.beforeAll(async ({ request }) => {
  const consent = await request.get("/auth/test-github");
  test.skip(consent.status() !== 200, "the app is not running with REELPLANE_TEST_AUTH=1");
});

const logins = [`alice-${randomUUID().slice(0, 6)}`, `bob-${randomUUID().slice(0, 6)}`];
const [alice = "", bob = ""] = logins;

test.afterAll(async () => {
  const pool = createPool(resolveDatabaseUrl(), { max: 1 });
  try {
    await pool.query("delete from reelplane.projects where owner_id = any($1::uuid[])", [
      logins.map((login) => testUserFor(login).id),
    ]);
  } finally {
    await pool.end();
  }
});

/** Click "Sign in with GitHub" on /login and authorize `login` on the (test) consent page. */
async function signIn(page: Page, login: string): Promise<void> {
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/auth\/test-github/);
  await page.getByLabel("GitHub login").fill(login);
  await page.getByRole("button", { name: "Authorize" }).click();
  // Wait for the redirect that sets the session, so the next navigation is signed in. Allow for
  // a busy machine: next to the playback tests (several tabs decoding video) it took over 5 s.
  await expect(page).not.toHaveURL(/\/auth\/test-github/, { timeout: 15_000 });
}

async function freshPage(browser: Browser): Promise<Page> {
  return (await browser.newContext()).newPage();
}

test("GitHub sign-in takes you to the dashboard, and signing out ends the session", async ({
  browser,
}) => {
  const page = await freshPage(browser);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, alice);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText(`@${alice}`)).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
});

test("signing in from /upload comes back to /upload", async ({ browser }) => {
  const page = await freshPage(browser);
  await page.goto("/upload");
  await page.getByRole("link", { name: "Sign in to upload" }).click();
  await signIn(page, bob);
  await expect(page).toHaveURL(/\/upload$/);
  await expect(page.getByRole("button", { name: "Upload a video" })).toBeVisible();
});

test("each GitHub account sees only its own projects", async ({ browser }) => {
  const alicePage = await freshPage(browser);
  await alicePage.goto("/login");
  await signIn(alicePage, alice);
  await alicePage.getByPlaceholder("New project name").fill(`Alice ${alice}`);
  await alicePage.getByRole("button", { name: "Create project" }).click();
  const open = alicePage.getByRole("link", { name: "Open the project →" });
  await expect(open).toBeVisible();
  const aliceProject = (await open.getAttribute("href"))?.split("/").at(-1) ?? "";

  const bobPage = await freshPage(browser);
  await bobPage.goto("/login");
  await signIn(bobPage, bob);
  await expect(bobPage.getByText(`@${bob}`)).toBeVisible();
  await expect(bobPage.getByRole("link", { name: `Alice ${alice}` })).toHaveCount(0);
  const response = await bobPage.goto(`/dashboard/${aliceProject}`);
  expect(response?.status()).toBe(404);
});

test("a forged session cookie counts as signed out", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await signIn(page, alice);
  await expect(page).toHaveURL(/\/dashboard$/);
  const cookie = (await context.cookies()).find((c) => c.name === "rp_test_session");
  expect(cookie).toBeDefined();
  // Swap the payload for another user's, keeping the signature.
  const [, mac] = (cookie?.value ?? "").split(".");
  const forged = Buffer.from(JSON.stringify({ ...testUserFor(bob), exp: 9e9 })).toString(
    "base64url",
  );
  await context.addCookies([
    { ...(cookie as NonNullable<typeof cookie>), value: `${forged}.${mac}` },
  ]);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
});
