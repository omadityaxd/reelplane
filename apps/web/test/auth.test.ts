import { randomUUID } from "node:crypto";
import { createPool, createProject, generateApiKey, revokeApiKey } from "@reelplane/db";
import { afterAll, describe, expect, inject, it } from "vitest";
import { apiRoute, corsPreflight, json } from "@/lib/server/api-route.ts";

const PEPPER = "web-test-pepper-0123456789abcdef0123";
const ALLOWED = "https://shop.example.com";

const pool = createPool(inject("databaseUrl"), { max: 4 });
afterAll(() => pool.end());
const deps = () => ({ pool, pepper: PEPPER });

const { project, publishableKey, secretKey } = await createProject(
  pool,
  { ownerId: randomUUID(), name: "web-auth", allowedOrigins: [ALLOWED] },
  PEPPER,
);

/** A route that echoes the auth context, for both key kinds. */
const readRoute = apiRoute(
  { allow: ["secret", "publishable"] },
  async ({ auth }) => json({ data: auth }),
  deps,
);
const writeRoute = apiRoute({ allow: ["secret"] }, async ({ auth }) => json({ data: auth }), deps);

function request(key?: string, origin?: string): Request {
  const headers = new Headers();
  if (key) headers.set("authorization", `Bearer ${key}`);
  if (origin) headers.set("origin", origin);
  return new Request("http://localhost/v1/test", { headers });
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

describe("API key auth middleware", () => {
  it("authenticates a secret key server-side", async () => {
    const response = await writeRoute(request(secretKey.key));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { projectId: project.id, credential: "secret", origin: null },
    });
  });

  it("handles the context Next.js passes to static routes (params undefined)", async () => {
    // Regression: `next start` passes `{ params: undefined }` on non-dynamic routes.
    const response = await writeRoute(request(secretKey.key), { params: undefined });
    expect(response.status).toBe(200);
  });

  it("rejects a missing key with 401", async () => {
    const response = await readRoute(request());
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("unauthorized");
  });

  it("rejects malformed, unknown and revoked keys with the same 401", async () => {
    const { project: other, secretKey: revoked } = await createProject(
      pool,
      { ownerId: randomUUID(), name: "revoked" },
      PEPPER,
    );
    await revokeApiKey(pool, other.id, revoked.record.id);

    for (const key of ["garbage", generateApiKey("secret"), revoked.key]) {
      const response = await readRoute(request(key));
      expect(response.status).toBe(401);
    }
  });

  it("does not let a publishable key call a write endpoint", async () => {
    const response = await writeRoute(request(publishableKey.key, ALLOWED));
    expect(response.status).toBe(403);
  });

  it("allows a publishable key from an allowed origin and returns CORS headers", async () => {
    const response = await readRoute(request(publishableKey.key, ALLOWED));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  });

  it("blocks a publishable key from another origin, without CORS headers", async () => {
    const response = await readRoute(request(publishableKey.key, "https://evil.example.net"));
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows a publishable key with no Origin (server-side fetch)", async () => {
    const response = await readRoute(request(publishableKey.key));
    expect(response.status).toBe(200);
  });

  it("refuses a secret key sent from a browser (leaked into client code)", async () => {
    const response = await writeRoute(request(secretKey.key, ALLOWED));
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("forbidden");
  });

  it("answers CORS preflight without needing a key", () => {
    const response = corsPreflight("GET, OPTIONS")(request(undefined, ALLOWED));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("hides internal errors behind a generic 500", async () => {
    const failing = apiRoute(
      { allow: ["secret"] },
      async () => {
        throw new Error("connection string with password leaked here");
      },
      deps,
    );
    const original = console.error;
    console.error = () => undefined;
    try {
      const response = await failing(request(secretKey.key));
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain("password");
    } finally {
      console.error = original;
    }
  });
});
