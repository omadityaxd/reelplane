import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { createPool, listApiKeys, resolveDatabaseUrl } from "@reelplane/db";
import { createClient } from "@supabase/supabase-js";

/**
 * Dashboard sign-in against the real Supabase project, and isolation between users.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY
 * (root .env), and the web app running with them. The service-role key is used only here, to
 * create two throwaway users and their one-time sign-in links (`auth.admin.generateLink`); no
 * email is sent. The links go through /auth/confirm, the same path a real email link takes.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
test.skip(!url || !serviceKey, "Supabase is not configured");

const admin =
  url && serviceKey ? createClient(url, serviceKey, { auth: { persistSession: false } }) : null;
const created: string[] = [];

async function newUser(label: string): Promise<{ id: string; email: string; signInPath: string }> {
  if (!admin) throw new Error("no admin client");
  const email = `reelplane-e2e-${label}-${randomUUID().slice(0, 8)}@example.com`;
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.user) throw error ?? new Error("generateLink returned no user");
  created.push(data.user.id);
  const tokenHash = data.properties.hashed_token;
  return {
    id: data.user.id,
    email,
    signInPath: `/auth/confirm?token_hash=${tokenHash}&type=email`,
  };
}

async function signedIn(browser: Browser, signInPath: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(signInPath);
  await expect(page).toHaveURL(/\/dashboard$/);
  return page;
}

async function createProject(page: Page, name: string): Promise<string> {
  await page.getByPlaceholder("New project name").fill(name);
  await page.getByRole("button", { name: "Create project" }).click();
  const open = page.getByRole("link", { name: "Open the project →" });
  await expect(open).toBeVisible();
  const href = await open.getAttribute("href");
  const id = href?.split("/").at(-1);
  if (!id) throw new Error("no project link");
  return id;
}

test.afterAll(async () => {
  if (!admin) return;
  const pool = createPool(resolveDatabaseUrl(), { max: 1 });
  try {
    // Projects belong to the test users; deleting them as the table owner removes the lot.
    await pool.query("delete from reelplane.projects where owner_id = any($1::uuid[])", [created]);
  } finally {
    await pool.end();
  }
  for (const id of created) await admin.auth.admin.deleteUser(id);
});

test("signed out, the dashboard sends you to sign in", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
});

test("a sign-in link works once", async ({ browser }) => {
  const user = await newUser("once");
  const page = await signedIn(browser, user.signInPath);
  await expect(page.getByText(user.email)).toBeVisible();

  const replay = await (await browser.newContext()).newPage();
  await replay.goto(user.signInPath);
  await expect(replay).toHaveURL(/\/login\?error=link$/);
});

test("one user can never see or change another user's projects", async ({ browser }) => {
  const alice = await newUser("alice");
  const bob = await newUser("bob");
  const alicePage = await signedIn(browser, alice.signInPath);
  const aliceProject = await createProject(alicePage, `Alice ${randomUUID().slice(0, 6)}`);
  await expect(alicePage.getByRole("link", { name: /^Alice / })).toBeVisible();

  const bobPage = await signedIn(browser, bob.signInPath);
  const bobProject = await createProject(bobPage, `Bob ${randomUUID().slice(0, 6)}`);

  // Not listed for Bob, and every page of it is a 404 for him.
  await bobPage.goto("/dashboard");
  await expect(bobPage.getByRole("link", { name: /^Alice / })).toHaveCount(0);
  for (const tab of ["", "/keys", "/webhooks", "/analytics", "/settings", "/jobs"]) {
    const response = await bobPage.goto(`/dashboard/${aliceProject}${tab}`);
    expect(response?.status(), `/dashboard/<alice>${tab}`).toBe(404);
  }

  // A server action is a public endpoint: send Bob's "create key" with Alice's project id.
  const pool = createPool(resolveDatabaseUrl(), { max: 1 });
  try {
    const before = (await listApiKeys(pool, aliceProject)).length;
    await bobPage.goto(`/dashboard/${bobProject}/keys`);
    await bobPage.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData();
      if (request.method() === "POST" && request.headers()["next-action"] && body) {
        await route.continue({ postData: body.replaceAll(bobProject, aliceProject) });
      } else {
        await route.continue();
      }
    });
    await bobPage.getByPlaceholder("Name, e.g. Production site").fill("stolen");
    await bobPage.getByRole("button", { name: "Create key" }).click();
    await bobPage.waitForTimeout(1500);
    expect((await listApiKeys(pool, aliceProject)).length).toBe(before);
    await expect(bobPage.locator(".dash-secret")).toHaveCount(0);
  } finally {
    await pool.end();
  }
});
