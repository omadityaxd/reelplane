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
      [bucket, windowSeconds],
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
  name: "client",
  limit: 600,
  windowSeconds: 60,
  by: "client",
};

/**
 * The caller's address. On Vercel `x-vercel-forwarded-for` and `x-real-ip` are set by the
 * platform and can't be forged; elsewhere put the app behind a proxy that overwrites
 * `x-forwarded-for`, or per-address limits can be dodged by sending a fake one.
 */
export function clientAddress(request: Request): string {
  const header = (name: string) => request.headers.get(name)?.split(",")[0]?.trim();
  return (
    header("x-vercel-forwarded-for") ||
    header("x-real-ip") ||
    header("x-forwarded-for") ||
    "unknown"
  );
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
