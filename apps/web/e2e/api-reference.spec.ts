import { expect, test } from "@playwright/test";

/** The reference page and /openapi.json come from one document: every operation is on the page. */
test("the API reference shows every operation in /openapi.json", async ({ page, request }) => {
  const response = await request.get("/openapi.json");
  expect(response.ok()).toBe(true);
  const doc = (await response.json()) as {
    openapi: string;
    paths: Record<string, Record<string, { operationId: string }>>;
  };
  expect(doc.openapi).toBe("3.1.0");
  const operations = Object.values(doc.paths).flatMap((methods) => Object.values(methods));
  expect(operations.length).toBeGreaterThan(10);

  await page.goto("/developers/api");
  await expect(page.getByRole("heading", { name: "API reference" })).toBeVisible();
  for (const op of operations) {
    await expect(page.locator(`section#${op.operationId}`)).toHaveCount(1);
  }
});
