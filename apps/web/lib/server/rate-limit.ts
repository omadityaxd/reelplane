import { createHash } from "node:crypto";
import type { Pool } from "@reelplane/db";
import { ApiError } from "./errors.ts";

/**
 * Rate limits, counted in Postgres (fixed windows in an UNLOGGED table, migration 0008). That
 * keeps the brief's "Upstash optional": with no Redis there is nothing extra to run, at the
 * cost of one small write per request. A Redis-backed RateLimiter can replace this without
 * touching any route.
 */
export interface RateLimitRule {
  /** Bucket family, e.g. "feed". */
  name: string;
  limit: number;
  windowSeconds: number;
  /**
   * What is counted: `credential` = one secret key / upload; `client` = one browser address
   * within one project (publishable traffic comes from many viewers sharing one key).
   */
  by: "credential" | "client";
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
}

export interface RateLimiter {
  hit(bucket: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

/** 429 with Retry-After, so well-behaved clients back off for the right time. */
export class RateLimitedError extends ApiError {
  constructor(readonly result: RateLimitResult) {
    super("rate_limited", "Too many requests. Slow down and retry after the Retry-After delay.");
  }
}

/**
 * `family:anything` → `family:<sha256 of anything>`: a fixed length whatever the address,
 * email or key in it (no oversized keys, no two buckets colliding through a crafted value).
 */
export function bucketKey(bucket: string): string {
  const at = bucket.indexOf(":");
  const family = (at < 0 ? bucket : bucket.slice(0, at)).slice(0, 40);
  const rest = at < 0 ? "" : bucket.slice(at + 1);
  return `${family}:${createHash("sha256").update(rest).digest("base64url")}`;
}

export class PostgresRateLimiter implements RateLimiter {
  /** `scale` multiplies every limit (RATE_LIMIT_SCALE; load tests only). */
  constructor(
    private readonly pool: Pool,
    private readonly scale = 1,
  ) {}

  async hit(bucket: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const scaled = Math.max(1, Math.round(limit * this.scale));
    const { rows } = await this.pool.query<{ hits: number; reset_at: Date }>(
      "select hits, reset_at from reelplane.rate_limit_hit($1, $2)",
      [bucketKey(bucket), windowSeconds],
    );
    const row = rows[0];
    if (!row) throw new Error("rate_limit_hit returned no row");
    return {
      allowed: row.hits <= scaled,
      limit: scaled,
      remaining: Math.max(0, scaled - row.hits),
      resetAt: row.reset_at,
    };
  }
}

/** Every client address gets this much of the whole API before authentication even runs. */
export const CLIENT_RULE: RateLimitRule = {
  name: "pre-auth",
  limit: 600,
  windowSeconds: 60,
  by: "client",
};

export type TrustedProxy = "vercel" | "proxy" | "none";

/**
 * Who sets the address headers. Next's own server only fills in `x-forwarded-for` when the
 * client didn't send one, so without a trusted proxy in front any address header is whatever
 * the client wrote, and per-address limits (and report counting) could be dodged with a fake.
 *
 * - `vercel` (default on Vercel): `x-vercel-forwarded-for`, which the platform sets and clients
 *   can't override.
 * - `proxy`: the last `x-forwarded-for` entry, the address your own proxy (nginx, Caddy, a
 *   load balancer) appended. Only use it when every request goes through that proxy.
 * - `none` (default elsewhere): no address is trusted; all clients share one bucket. Safe, but
 *   one busy client can then rate-limit everyone, so set TRUSTED_PROXY when self-hosting.
 */
export function trustedProxy(env: Record<string, string | undefined> = process.env): TrustedProxy {
  const value = env.TRUSTED_PROXY;
  if (value === "vercel" || value === "proxy" || value === "none") return value;
  return env.VERCEL ? "vercel" : "none";
}

/** An IPv6 client can change its last 64 bits at will: count its /64, like one address. */
function normalizeAddress(address: string): string {
  if (!address.includes(":")) return address;
  return address.split(":").slice(0, 4).join(":");
}

/** The caller's address under the configured trust (see trustedProxy). */
export function clientAddress(request: Request, proxy: TrustedProxy = trustedProxy()): string {
  if (proxy === "vercel") {
    const address = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
    return address ? normalizeAddress(address) : "unknown";
  }
  if (proxy === "proxy") {
    const address = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    return address ? normalizeAddress(address) : "unknown";
  }
  return "untrusted";
}

export function rateLimitHeaders(result: RateLimitResult, now = Date.now()): Headers {
  const resetSeconds = Math.max(0, Math.ceil((result.resetAt.getTime() - now) / 1000));
  const headers = new Headers({
    "ratelimit-limit": String(result.limit),
    "ratelimit-remaining": String(result.remaining),
    "ratelimit-reset": String(resetSeconds),
  });
  if (!result.allowed) headers.set("retry-after", String(resetSeconds));
  return headers;
}

/** Counts a hit and throws RateLimitedError if the bucket is over its limit. */
export async function enforce(
  limiter: RateLimiter,
  bucket: string,
  rule: Pick<RateLimitRule, "limit" | "windowSeconds">,
): Promise<RateLimitResult> {
  const result = await limiter.hit(bucket, rule.limit, rule.windowSeconds);
  if (!result.allowed) throw new RateLimitedError(result);
  return result;
}

const MINUTE = 60;

/**
 * Every endpoint's rule, in one place. Browser endpoints count per viewer address (a popular
 * app's feed is many viewers on one publishable key); server endpoints count per key.
 */
export const RULES = {
  feed: { name: "feed", limit: 120, windowSeconds: MINUTE, by: "client" },
  playbackEvents: { name: "events", limit: 120, windowSeconds: MINUTE, by: "client" },
  like: { name: "like", limit: 60, windowSeconds: MINUTE, by: "client" },
  report: { name: "report", limit: 10, windowSeconds: MINUTE, by: "client" },
  project: { name: "project", limit: 60, windowSeconds: MINUTE, by: "credential" },
  readVideos: { name: "videos", limit: 300, windowSeconds: MINUTE, by: "credential" },
  deleteVideo: { name: "delete", limit: 120, windowSeconds: MINUTE, by: "credential" },
  createUpload: { name: "upload", limit: 30, windowSeconds: MINUTE, by: "credential" },
  uploadParts: { name: "parts", limit: 120, windowSeconds: MINUTE, by: "credential" },
  finishUpload: { name: "finish", limit: 30, windowSeconds: MINUTE, by: "credential" },
} as const satisfies Record<string, RateLimitRule>;
