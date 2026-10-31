import "server-only";
import { createStorage, type ObjectStorage } from "@reelplane/storage";
import { db } from "./db.ts";
import type { AppDeps } from "./deps.ts";
import { apiKeyPepperFromEnv } from "./env.ts";
import { DEFAULT_UPLOAD_LIMITS } from "./uploads/limits.ts";

const globalForStorage = globalThis as unknown as { reelplaneStorage?: ObjectStorage };

/** Production dependencies for `apiRoute`; tests pass their own. */
export function appDeps(): AppDeps {
  globalForStorage.reelplaneStorage ??= createStorage();
  return {
    pool: db(),
    pepper: apiKeyPepperFromEnv(),
    storage: globalForStorage.reelplaneStorage,
    limits: DEFAULT_UPLOAD_LIMITS,
  };
}
