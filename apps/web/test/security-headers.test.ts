import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "../lib/security-headers.ts";

const production = {
  NODE_ENV: "production",
  NEXT_PUBLIC_SUPABASE_URL: "https://ref.supabase.co",
  STORAGE_PUBLIC_BASE_URL: "https://ref.supabase.co/storage/v1/object/public/reelplane",
  STORAGE_ENDPOINT: "https://ref.storage.supabase.co/storage/v1/s3",
};

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split("; ").map((d) => {
      const [name = "", ...sources] = d.split(" ");
      return [name, sources];
    }),
  );
}

describe("security headers", () => {
  it("sends the hardening headers everywhere, and the CSP only from a build", () => {
    const keys = (env: Record<string, string>) => securityHeaders(env).map((h) => h.key);
    expect(keys(production)).toEqual([
      "X-Content-Type-Options",
      "Referrer-Policy",
      "X-Frame-Options",
      "Permissions-Policy",
      "Cross-Origin-Opener-Policy",
      "Strict-Transport-Security",
      "Content-Security-Policy",
    ]);
    expect(keys({ ...production, NODE_ENV: "development" })).not.toContain(
      "Content-Security-Policy",
    );
  });

  it("allows exactly this deployment's Supabase and storage hosts", () => {
    const csp = directives(contentSecurityPolicy(production));
    expect(csp.get("connect-src")).toEqual([
      "'self'",
      "https://ref.supabase.co",
      "https://ref.storage.supabase.co",
    ]);
    expect(csp.get("media-src")).toEqual([
      "'self'",
      "blob:",
      "https://ref.supabase.co",
      "https://ref.storage.supabase.co",
    ]);
    expect(csp.get("script-src")).toEqual(["'self'", "'unsafe-inline'"]); // no external scripts
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("form-action")).toEqual([
      "'self'",
      "https://ref.supabase.co",
      "https://github.com",
    ]);
    expect(csp.has("upgrade-insecure-requests")).toBe(true);
  });

  it("does not upgrade to https when local storage is plain http", () => {
    const csp = contentSecurityPolicy({
      NODE_ENV: "production",
      STORAGE_PUBLIC_BASE_URL: "http://localhost:9000/reelplane",
    });
    expect(csp).toContain("media-src 'self' blob: http://localhost:9000");
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(csp).toContain("form-action 'self';");
  });
});
