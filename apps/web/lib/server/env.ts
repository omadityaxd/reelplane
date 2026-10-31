import "server-only";
import { resolveDatabaseUrl, resolvePepper } from "@reelplane/db";

let databaseUrl: string | undefined;
let apiKeyPepper: string | undefined;

/**
 * Server-only configuration, resolved lazily and separately so that a missing secret fails
 * with its own message instead of masquerading as another problem (e.g. "database down").
 * Importing this from a client component fails the build.
 */
export function databaseUrlFromEnv(): string {
  databaseUrl ??= resolveDatabaseUrl();
  return databaseUrl;
}

export function apiKeyPepperFromEnv(): string {
  apiKeyPepper ??= resolvePepper();
  return apiKeyPepper;
}
