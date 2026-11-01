import { describe, expect, it } from "vitest";
import { LOCAL_STORAGE_DEFAULTS, loadStorageConfig } from "./config.ts";

const b2Env = {
  STORAGE_PROVIDER: "b2",
  STORAGE_ENDPOINT: "https://s3.us-west-004.backblazeb2.com/",
  STORAGE_REGION: "us-west-004",
  STORAGE_BUCKET: "reelplane-demo",
  STORAGE_ACCESS_KEY_ID: "key-id",
  STORAGE_SECRET_ACCESS_KEY: "secret",
};

describe("loadStorageConfig", () => {
  it("falls back to the local RustFS container when nothing is configured", () => {
    // Unrelated STORAGE_* flags (like the test switch) must not disable the fallback.
    const config = loadStorageConfig({ PATH: "/usr/bin", STORAGE_INTEGRATION: "1" });
    expect(config.provider).toBe("local");
    expect(config.endpoint).toBe(LOCAL_STORAGE_DEFAULTS.STORAGE_ENDPOINT);
    expect(config.forcePathStyle).toBe(true);
    expect(config.publicBaseUrl).toBe("http://localhost:9000/reelplane");
  });

  it("keeps local defaults when only the public URL is overridden (LAN playback)", () => {
    const config = loadStorageConfig({
      STORAGE_PUBLIC_BASE_URL: "http://192.168.1.12:9000/reelplane",
    });
    expect(config.provider).toBe("local");
    expect(config.publicBaseUrl).toBe("http://192.168.1.12:9000/reelplane");
  });

  it("switches provider purely through env vars", () => {
    const config = loadStorageConfig(b2Env);
    expect(config.provider).toBe("b2");
    expect(config.endpoint).toBe("https://s3.us-west-004.backblazeb2.com");
    expect(config.forcePathStyle).toBe(false);
    expect(config.publicBaseUrl).toBe("https://reelplane-demo.s3.us-west-004.backblazeb2.com");
  });

  it("prefers an explicit public (CDN) base URL", () => {
    const config = loadStorageConfig({
      ...b2Env,
      STORAGE_PUBLIC_BASE_URL: "https://cdn.example.com/",
    });
    expect(config.publicBaseUrl).toBe("https://cdn.example.com");
  });

  it("honours an explicit path-style flag", () => {
    expect(loadStorageConfig({ ...b2Env, STORAGE_FORCE_PATH_STYLE: "1" }).forcePathStyle).toBe(
      true,
    );
  });

  it("rejects a partial configuration with a readable message", () => {
    expect(() => loadStorageConfig({ STORAGE_PROVIDER: "r2" })).toThrow(
      /Invalid storage configuration: .*STORAGE_ENDPOINT/,
    );
  });

  it("rejects an unknown provider", () => {
    expect(() => loadStorageConfig({ ...b2Env, STORAGE_PROVIDER: "dropbox" })).toThrow(
      /STORAGE_PROVIDER/,
    );
  });
});
