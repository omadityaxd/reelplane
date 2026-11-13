import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Test-mode GitHub sign-in (REELPLANE_TEST_AUTH=1, see auth-mode.ts): instead of GitHub, a local
 * consent page asks for a login and this module mints a signed session for it. Pure functions,
 * so the signing is unit-tested; the cookie plumbing lives in session.ts and the routes.
 */
export const TEST_SESSION_COOKIE = "rp_test_session";
const SESSION_SECONDS = 8 * 3600;
export const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;

export interface TestUser {
  id: string;
  login: string;
  email: string;
}

/** A stable user id per login (UUID-shaped), like a real account's. */
export function testUserFor(login: string): TestUser {
  const hex = createHash("sha256")
    .update(`reelplane-test-github:${login.toLowerCase()}`)
    .digest("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return {
    id,
    login: login.toLowerCase(),
    email: `${login.toLowerCase()}@users.noreply.github.test`,
  };
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** `<base64url(json)>.<hmac>`, valid for 8 hours. */
export function signTestSession(user: TestUser, secret: string, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ ...user, exp: Math.floor(now / 1000) + SESSION_SECONDS }),
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** The user in a valid, unexpired session cookie; null for anything else. */
export function readTestSession(
  cookie: string | undefined,
  secret: string,
  now = Date.now(),
): TestUser | null {
  if (!cookie) return null;
  const [payload, mac] = cookie.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TestUser & {
      exp: number;
    };
    if (typeof value.exp !== "number" || value.exp * 1000 <= now) return null;
    if (!GITHUB_LOGIN.test(value.login)) return null;
    return testUserFor(value.login);
  } catch {
    return null;
  }
}
