import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encrypts secrets the API must store and give back later (an upload token kept for an
 * idempotent replay), so that database access alone does not reveal them. AES-256-GCM, with a
 * key derived from API_KEY_PEPPER, which lives only in the server's environment.
 */
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyFor(pepper: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", pepper, "", `reelplane sealed: ${purpose}`, 32));
}

/** Encrypts `secret` for `purpose`; open it with the same pepper and purpose. */
export function seal(secret: string, pepper: string, purpose: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFor(pepper, purpose), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
}

/** Decrypts a sealed value; throws if it was altered, or sealed with another key or purpose. */
export function open(sealed: string, pepper: string, purpose: string): string {
  const [version, payload] = sealed.split(".");
  if (version !== VERSION || !payload) throw new Error("unsupported sealed value");
  const raw = Buffer.from(payload, "base64url");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("sealed value is too short");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyFor(pepper, purpose),
    raw.subarray(0, IV_BYTES),
  );
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}
