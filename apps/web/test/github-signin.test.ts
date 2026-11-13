import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { authMode } from "@/lib/server/dashboard/auth-mode.ts";
import { githubSignIn } from "@/lib/server/dashboard/github.ts";
import { readTestSession, signTestSession, testUserFor } from "@/lib/server/dashboard/test-auth.ts";

describe("test-mode GitHub sign-in", () => {
  it("is only allowed off Vercel and against a local database", () => {
    expect(authMode({ REELPLANE_TEST_AUTH: "1" })).toBe("test");
    expect(
      authMode({ REELPLANE_TEST_AUTH: "1", DATABASE_URL: "postgres://u:p@localhost:54320/db" }),
    ).toBe("test");
    expect(authMode({ REELPLANE_TEST_AUTH: "1", VERCEL: "1" })).not.toBe("test");
    expect(
      authMode({
        REELPLANE_TEST_AUTH: "1",
        DATABASE_URL: "postgres://u:p@aws-0-ap-south-1.pooler.supabase.com:5432/postgres",
      }),
    ).not.toBe("test");
    expect(authMode({ REELPLANE_TEST_AUTH: "true" })).not.toBe("test");
  });

  it("signs sessions that can't be forged, altered or reused after they expire", () => {
    const alice = testUserFor("Alice");
    const cookie = signTestSession(alice, "secret", 0);
    expect(readTestSession(cookie, "secret", 1000)).toEqual(alice);
    expect(readTestSession(cookie, "other-secret", 1000)).toBeNull();
    const [payload, mac] = cookie.split(".");
    const bob = Buffer.from(JSON.stringify({ ...testUserFor("bob"), exp: 9e9 })).toString(
      "base64url",
    );
    expect(readTestSession(`${bob}.${mac}`, "secret", 1000)).toBeNull();
    expect(readTestSession(`${payload}.`, "secret", 1000)).toBeNull();
    expect(readTestSession(cookie, "secret", 9 * 3600 * 1000)).toBeNull(); // 8 h lifetime
  });

  it("gives each login its own stable user id", () => {
    expect(testUserFor("alice").id).toBe(testUserFor("ALICE").id);
    expect(testUserFor("alice").id).not.toBe(testUserFor("bob").id);
    expect(testUserFor("alice").id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("real GitHub sign-in (Supabase)", () => {
  it("asks Supabase for GitHub with PKCE and comes back to /auth/callback", async () => {
    // The real Supabase client, with a fake project URL: building the authorize URL needs no
    // network and no GitHub credentials.
    const store = new Map<string, string>();
    const supabase = createClient("https://abcd.supabase.co", "anon-key", {
      auth: {
        flowType: "pkce",
        persistSession: true,
        storage: {
          getItem: (key) => store.get(key) ?? null,
          setItem: (key, value) => void store.set(key, value),
          removeItem: (key) => void store.delete(key),
        },
      },
    });
    const { data, error } = await supabase.auth.signInWithOAuth(
      githubSignIn("https://reelplane.example", "/upload"),
    );
    expect(error).toBeNull();
    const url = new URL(data.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://abcd.supabase.co/auth/v1/authorize");
    expect(url.searchParams.get("provider")).toBe("github");
    expect(url.searchParams.get("redirect_to")).toBe(
      "https://reelplane.example/auth/callback?next=%2Fupload",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("s256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    // The verifier stays in this browser's storage (cookies, on the server client).
    expect([...store.keys()].some((key) => key.endsWith("code-verifier"))).toBe(true);
  });
});
