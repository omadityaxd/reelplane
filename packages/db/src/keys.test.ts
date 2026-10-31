import { describe, expect, it } from "vitest";
import { displayPrefix, generateApiKey, hashApiKey, parseApiKey, resolvePepper } from "./keys.ts";

describe("api key format", () => {
  it("generates keys that identify their kind and pass their own checksum", () => {
    const secret = generateApiKey("secret");
    const publishable = generateApiKey("publishable");

    expect(secret).toMatch(/^rp_sk_[0-9A-Za-z]{49}$/);
    expect(publishable).toMatch(/^rp_pk_[0-9A-Za-z]{49}$/);
    expect(parseApiKey(secret)).toBe("secret");
    expect(parseApiKey(publishable)).toBe("publishable");
  });

  it("never generates the same key twice", () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateApiKey("secret")));
    expect(keys.size).toBe(1000);
  });

  it("rejects a key with a single changed character (checksum)", () => {
    const key = generateApiKey("secret");
    const index = 10;
    const swapped = key[index] === "a" ? "b" : "a";
    const typo = key.slice(0, index) + swapped + key.slice(index + 1);
    expect(parseApiKey(typo)).toBeNull();
  });

  it("rejects a key whose kind tag was edited", () => {
    const key = generateApiKey("publishable");
    expect(parseApiKey(key.replace("rp_pk_", "rp_sk_"))).toBeNull();
  });

  it.each(["", "rp_sk_short", "sk_live_123", `rp_xx_${"a".repeat(49)}`, "Bearer rp_sk_x"])(
    "rejects malformed input %j",
    (raw) => {
      expect(parseApiKey(raw)).toBeNull();
    },
  );

  it("hashes deterministically per pepper", () => {
    const key = generateApiKey("secret");
    expect(hashApiKey(key, "a".repeat(32)).equals(hashApiKey(key, "a".repeat(32)))).toBe(true);
    expect(hashApiKey(key, "a".repeat(32)).equals(hashApiKey(key, "b".repeat(32)))).toBe(false);
  });

  it("only displays a short, non-secret prefix", () => {
    expect(displayPrefix(generateApiKey("secret"))).toMatch(/^rp_sk_[0-9A-Za-z]{6}$/);
  });
});

describe("resolvePepper", () => {
  it("uses a dev pepper outside production", () => {
    expect(resolvePepper({}).length).toBeGreaterThanOrEqual(32);
  });

  it("requires a pepper in production", () => {
    expect(() => resolvePepper({ NODE_ENV: "production" })).toThrow(/API_KEY_PEPPER is required/);
  });

  it("rejects a short pepper", () => {
    expect(() => resolvePepper({ API_KEY_PEPPER: "short" })).toThrow(/at least 32/);
  });
});
