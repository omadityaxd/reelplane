import { afterEach, describe, expect, it, vi } from "vitest";
import { newSessionId } from "./metrics.ts";

describe("newSessionId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is a random UUID", () => {
    expect(newSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("stays cryptographically random on plain-http pages, which have no crypto.randomUUID", () => {
    // A page on http://192.168.x.x is not a secure context: randomUUID is missing there,
    // getRandomValues is not.
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const random = vi.spyOn(Math, "random");
    const ids = new Set(Array.from({ length: 100 }, () => newSessionId()));
    expect(ids.size).toBe(100);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(random).not.toHaveBeenCalled();
  });
});
