import type { SupportedContentType } from "./limits.ts";

/** Bytes needed from the start of a file to identify its container. */
export const SNIFF_BYTES = 64;

export type Container = "isobmff" | "matroska";

/**
 * ISO-BMFF `ftyp` major brands that are images or audio, not video. HEIC photos and M4A audio
 * share the MP4 container, so "has an ftyp box" alone would accept a renamed photo.
 */
const NON_VIDEO_BRANDS = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "mif1",
  "msf1",
  "avif",
  "avis",
  "M4A ",
  "M4B ",
  "M4P ",
  "crx ",
  "jp2 ",
  "jpx ",
]);

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

/**
 * Identifies the container from magic bytes, ignoring the file name and declared type.
 * This is a cheap first gate; the worker still runs ffprobe on every upload.
 */
export function detectContainer(header: Uint8Array): Container | null {
  if (header.length >= 12 && ascii(header, 4, 4) === "ftyp") {
    const brand = ascii(header, 8, 4);
    return NON_VIDEO_BRANDS.has(brand) ? null : "isobmff";
  }
  if (header.length >= 4 && EBML_MAGIC.every((byte, index) => header[index] === byte)) {
    return "matroska";
  }
  return null;
}

const CONTAINER_FOR_TYPE: Record<SupportedContentType, Container> = {
  "video/mp4": "isobmff",
  "video/quicktime": "isobmff",
  "video/webm": "matroska",
  "video/x-matroska": "matroska",
};

export function matchesDeclaredType(
  container: Container,
  contentType: SupportedContentType,
): boolean {
  return CONTAINER_FOR_TYPE[contentType] === container;
}
