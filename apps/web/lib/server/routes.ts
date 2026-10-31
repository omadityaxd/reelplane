import "server-only";
import type { AuthDeps } from "./auth.ts";
import { db } from "./db.ts";
import { apiKeyPepperFromEnv } from "./env.ts";

/** Production dependencies for `apiRoute`; tests pass their own. */
export function appDeps(): AuthDeps {
  return { pool: db(), pepper: apiKeyPepperFromEnv() };
}
