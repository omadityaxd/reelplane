import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Loads the repo-root .env into process.env (if present) without overriding real env vars. */
export function loadRootEnv(): void {
  const path = resolve(import.meta.dirname, "..", ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}

export const LOCAL_DATABASE_URL = "postgres://reelplane:reelplane@localhost:54320/reelplane";
