import { describe, expect, it } from "vitest";
import { detectContainer, matchesDeclaredType } from "@/lib/server/uploads/sniff.ts";

function ftyp(brand: string): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0, 0, 0, 0x18], 0);
  bytes.set(new TextEncoder().encode(`ftyp${brand}`), 4);
  return bytes;
}

describe("detectContainer", () => {
  it.each(["isom", "mp42", "avc1", "qt  ", "M4V "])("accepts the %j video brand", (brand) => {
    expect(detectContainer(ftyp(brand))).toBe("isobmff");
  });

  it.each(["heic", "mif1", "avif", "M4A "])("rejects the %j image/audio brand", (brand) => {
    expect(detectContainer(ftyp(brand))).toBeNull();
  });

  it("recognises WebM/Matroska by its EBML header", () => {
    expect(detectContainer(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).toBe("matroska");
  });

  it.each([
    ["a PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]],
    ["a JPEG", [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]],
    ["plain text", [...new TextEncoder().encode("hello world!")]],
    ["an empty file", []],
  ])("rejects %s", (_name, bytes) => {
    expect(detectContainer(new Uint8Array(bytes))).toBeNull();
  });

  it("requires the container to match the declared type", () => {
    expect(matchesDeclaredType("isobmff", "video/quicktime")).toBe(true);
    expect(matchesDeclaredType("matroska", "video/mp4")).toBe(false);
  });
});
