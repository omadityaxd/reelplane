import { describe, expect, it } from "vitest";
import { originalKey } from "@/lib/server/uploads/service.ts";

const PROJECT = "e1c1b191-96ee-4488-95a9-0b476d15d3ab";
const VIDEO = "193e65fa-011c-401d-8c0a-1c24cd5b5ce8";

describe("original upload keys", () => {
  it("cannot be derived from the public project and video ids", () => {
    const key = originalKey(PROJECT, VIDEO);
    expect(key).toMatch(new RegExp(`^originals/${PROJECT}/${VIDEO}/[0-9a-f]{32}/source$`));
    expect(key).not.toBe(`originals/${PROJECT}/${VIDEO}/source`);
  });

  it("are different for every upload, even of the same video id", () => {
    const keys = new Set(Array.from({ length: 1000 }, () => originalKey(PROJECT, VIDEO)));
    expect(keys.size).toBe(1000);
  });

  it("stay under the video's originals/ prefix, which deleting the video sweeps", () => {
    expect(originalKey(PROJECT, VIDEO).startsWith(`originals/${PROJECT}/${VIDEO}/`)).toBe(true);
  });
});
