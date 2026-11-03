import { randomUUID } from "node:crypto";
import { createPool, createProject, generateApiKey, revokeApiKey } from "@reelplane/db";
import { afterAll, describe, expect, inject, it } from "vitest";
import { apiRoute, corsPreflight, json } from "@/lib/server/api-route.ts";
import { PostgresRateLimiter, type RateLimitRule } from "@/lib/server/rate-limit.ts";

const PEPPER = "web-test-pepper-0123456789abcdef0123";
const ALLOWED = "https://shop.example.com";

const pool = createPool(inject("databaseUrl"), { max: 4 });
afterAll(() => pool.end());
const deps = () => ({ pool, pepper: PEPPER });
const RULE: RateLimitRule = { name: "test", limit: 100, windowSeconds: 60, by: "credential" };

const { project, publishableKey, secretKey } = await createProject(
  pool,
  { ownerId: randomUUID(), name: "web-auth", allowedOrigins: [ALLOWED] },
  PEPPER,
);

/** A route that echoes the auth context, for both key kinds. */
const readRoute = apiRoute(
  { allow: ["secret", "publishable"], rateLimit: RULE },
  async ({ auth }) => json({ data: auth }),
  deps,
);
const writeRoute = apiRoute(
  { allow: ["secret"], rateLimit: RULE },
  async ({ auth }) => json({ data: auth }),
  deps,
);

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
      { allow: ["secret"], rateLimit: RULE },
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

describe("rate limits", () => {
  // Scale 0.03: the endpoint rule allows 3 per window, the per-address budget 18.
  const limited = (rule: RateLimitRule) =>
    apiRoute(
      { allow: ["secret", "publishable"], rateLimit: rule },
      async () => json({ ok: true }),
      () => ({
        pool,
        pepper: PEPPER,
        rateLimiter: new PostgresRateLimiter(pool, 0.03),
      }),
    );
  const from = (address: string, key = secretKey.key, origin?: string) => {
    const r = request(key, origin);
    r.headers.set("x-forwarded-for", `${address}, 10.0.0.1`);
    return r;
  };

  it("answers 429 with Retry-After once a key is over its endpoint's limit", async () => {
    const route = limited({ ...RULE, name: `per-key-${randomUUID()}` });
    const address = `198.51.100.${Math.floor(Math.random() * 250)}`;
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await route(from(address))).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const blocked = await route(from(address));
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(blocked.headers.get("ratelimit-remaining")).toBe("0");
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  });

  it("counts browser traffic per viewer address, so one viewer can't block the others", async () => {
    const route = limited({ ...RULE, name: `per-viewer-${randomUUID()}`, by: "client" });
    for (let i = 0; i < 3; i += 1) await route(from("203.0.113.7", publishableKey.key, ALLOWED));
    expect((await route(from("203.0.113.7", publishableKey.key, ALLOWED))).status).toBe(429);
    expect((await route(from("203.0.113.8", publishableKey.key, ALLOWED))).status).toBe(200);
  });

  it("limits each address before authentication, so floods of bad keys stay cheap", async () => {
    const route = limited({ ...RULE, name: `pre-auth-${randomUUID()}` });
    const address = `192.0.2.${Math.floor(Math.random() * 250)}`;
    const statuses = new Set<number>();
    for (let i = 0; i < 20; i += 1)
      statuses.add((await route(from(address, generateApiKey("secret")))).status);
    expect(statuses).toEqual(new Set([401, 429]));
  });
});
