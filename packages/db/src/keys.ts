import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { crc32 } from "node:zlib";

/**
 * API key format: `rp_<pk|sk>_<43 base62 chars of entropy><6 base62 chars of CRC32>`.
 *
 * - The prefix makes keys greppable by secret scanners and tells us the kind without a lookup.
 * - The checksum lets us reject typos and garbage before touching the database.
 * - 32 random bytes is far beyond brute-force range, so a fast keyed hash (HMAC-SHA256 with a
 *   server-side pepper) is the right storage format: it allows an indexed lookup, and a leaked
 *   database alone is not enough to verify guesses.
 */
export type ApiKeyKind = "publishable" | "secret";

const KIND_TAG: Record<ApiKeyKind, string> = { publishable: "pk", secret: "sk" };
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ENTROPY_BYTES = 32;
const BODY_LENGTH = 43;
const CHECKSUM_LENGTH = 6;
const KEY_PATTERN = /^rp_(pk|sk)_([0-9A-Za-z]{43})([0-9A-Za-z]{6})$/;
const DISPLAY_PREFIX_LENGTH = 12;

/** Development-only pepper. Production refuses to start without API_KEY_PEPPER. */
const DEV_PEPPER = "reelplane-dev-pepper-do-not-use-in-production";
const MIN_PEPPER_LENGTH = 32;

function toBase62(bytes: Uint8Array, length: number): string {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let out = "";
  while (value > 0n) {
    out = BASE62[Number(value % 62n)] + out;
    value /= 62n;
  }
  return out.padStart(length, "0").slice(-length);
}

function checksumFor(body: string): string {
  const crc = crc32(body);
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, crc);
  return toBase62(bytes, CHECKSUM_LENGTH);
}

export function generateApiKey(kind: ApiKeyKind): string {
  const body = `rp_${KIND_TAG[kind]}_${toBase62(randomBytes(ENTROPY_BYTES), BODY_LENGTH)}`;
  return body + checksumFor(body);
}

/** Validates format and checksum. Returns the key kind, or null for anything malformed. */
export function parseApiKey(raw: string): ApiKeyKind | null {
  const match = KEY_PATTERN.exec(raw);
  if (!match) return null;
  const [, tag, entropy, checksum] = match;
  const expected = checksumFor(`rp_${tag}_${entropy}`);
  const isValid =
    checksum !== undefined && timingSafeEqual(Buffer.from(checksum), Buffer.from(expected));
  if (!isValid) return null;
  return tag === "pk" ? "publishable" : "secret";
}

export function hashApiKey(key: string, pepper: string): Buffer {
  return createHmac("sha256", pepper).update(key).digest();
}

export function displayPrefix(key: string): string {
  return key.slice(0, DISPLAY_PREFIX_LENGTH);
}

export function resolvePepper(env: Record<string, string | undefined> = process.env): string {
  const pepper = env.API_KEY_PEPPER;
  if (pepper) {
    if (pepper.length < MIN_PEPPER_LENGTH) {
      throw new Error(`API_KEY_PEPPER must be at least ${MIN_PEPPER_LENGTH} characters`);
    }
    return pepper;
  }
  if (env.NODE_ENV === "production") {
    throw new Error("API_KEY_PEPPER is required in production");
  }
  return DEV_PEPPER;
}
