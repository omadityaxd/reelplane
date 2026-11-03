import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authMode } from "@/lib/server/dashboard/auth-mode.ts";

const SUPABASE = {
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
};

describe("dashboard auth mode", () => {
  it("uses Supabase whenever it is configured", () => {
    expect(authMode({ ...SUPABASE, NODE_ENV: "production", VERCEL: "1" })).toBe("supabase");
    expect(authMode({ ...SUPABASE, NODE_ENV: "development" })).toBe("supabase");
  });

  it("allows the no-sign-in local mode only in development or when explicitly enabled", () => {
    expect(authMode({ NODE_ENV: "development" })).toBe("local");
    expect(authMode({ NODE_ENV: "production" })).toBe("disabled");
    expect(authMode({ NODE_ENV: "production", REELPLANE_LOCAL_AUTH: "1" })).toBe("local");
  });

  it("never runs without sign-in on Vercel, even if asked to", () => {
    expect(authMode({ VERCEL: "1", NODE_ENV: "development" })).toBe("disabled");
    expect(authMode({ VERCEL: "1", REELPLANE_LOCAL_AUTH: "1" })).toBe("disabled");
  });

  it("needs both Supabase settings", () => {
    expect(
      authMode({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NODE_ENV: "production" }),
    ).toBe("disabled");
  });
});

/**
 * Every exported server action is a public POST endpoint: anyone can call it with any
 * arguments. So each one must check the caller first (requireProject re-checks ownership of
 * the project id it is given; requireUser checks sign-in). A new action without the check
 * fails here.
 */
describe("dashboard server actions", () => {
  const app = join(import.meta.dirname, "..", "app");
  const dir = join(app, "dashboard", "_actions");
  const files = [
    ...readdirSync(dir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(dir, name)),
    join(app, "upload", "actions.ts"),
  ];

  it.each(files)("%s: every exported action checks the caller before anything else", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source.startsWith('"use server";')).toBe(true);
    const actions = [...source.matchAll(/export async function (\w+)\([\s\S]*?\{\n([^\n]*)/g)];
    expect(actions.length).toBeGreaterThan(0);
    for (const [, action, firstLine] of actions) {
      expect(firstLine, action).toMatch(
        /^\s+(const \{[^}]*\} = |const \w+ = )?await require(Project\(projectId\)|User\(\));$/,
      );
    }
    // Only async functions (and types) may be exported from a "use server" file.
    expect(source).not.toMatch(/^export (const|let|class|function)\b/m);
  });
});
