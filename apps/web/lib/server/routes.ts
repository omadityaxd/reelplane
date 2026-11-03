import "server-only";
import { createStorage, type ObjectStorage } from "@reelplane/storage";
import { db } from "./db.ts";
import type { AppDeps } from "./deps.ts";
import { apiKeyPepperFromEnv } from "./env.ts";
import { PostgresRateLimiter } from "./rate-limit.ts";
import { DEFAULT_UPLOAD_LIMITS } from "./uploads/limits.ts";

const globalForStorage = globalThis as unknown as { reelplaneStorage?: ObjectStorage };

/**
 * RATE_LIMIT_SCALE multiplies every limit: for load tests only (see docs/BENCHMARKS.md), so it
 * is ignored on Vercel, where a stray value would quietly weaken production.
 */
function rateLimitScale(): number {
  if (process.env.VERCEL) return 1;
  const scale = Number(process.env.RATE_LIMIT_SCALE ?? 1);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Production dependencies for `apiRoute`; tests pass their own. */
export function appDeps(): AppDeps {
  globalForStorage.reelplaneStorage ??= createStorage();
  return {
    pool: db(),
    pepper: apiKeyPepperFromEnv(),
    storage: globalForStorage.reelplaneStorage,
    limits: DEFAULT_UPLOAD_LIMITS,
    rateLimiter: new PostgresRateLimiter(db(), rateLimitScale()),
  };
}
