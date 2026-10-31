import { randomBytes } from "node:crypto";

/**
 * Upload tokens let a browser upload ONE video without holding a project key. They are
 * random 32-byte capabilities, scoped to a video id and its upload expiry, stored hashed.
 */
const PREFIX = "rp_ut_";
const TOKEN_PATTERN = /^rp_ut_[A-Za-z0-9_-]{43}$/;

export function generateUploadToken(): string {
  return PREFIX + randomBytes(32).toString("base64url");
}

export function isUploadToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}
