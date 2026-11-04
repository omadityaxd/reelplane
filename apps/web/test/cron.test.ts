import { describe, expect, it } from "vitest";
import { cronAuthError } from "@/lib/server/cron.ts";

const request = (authorization?: string) =>
  new Request("http://app.test/api/cron/cleanup", {
    headers: authorization ? { authorization } : {},
  });

describe("cron authentication", () => {
  it("refuses everything when CRON_SECRET is not configured", async () => {
    expect(cronAuthError(request("Bearer anything"), undefined)?.status).toBe(503);
    expect(cronAuthError(request("Bearer "), "")?.status).toBe(503);
  });

  it("accepts only the exact bearer secret", () => {
    expect(cronAuthError(request(), "s3cret")?.status).toBe(401);
    expect(cronAuthError(request("Bearer wrong"), "s3cret")?.status).toBe(401);
    expect(cronAuthError(request("s3cret"), "s3cret")?.status).toBe(401);
    expect(cronAuthError(request("Bearer s3cret"), "s3cret")).toBeNull();
  });
});
