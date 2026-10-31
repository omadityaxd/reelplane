import "server-only";
import { createPool, type Pool } from "@reelplane/db";
import { databaseUrlFromEnv } from "./env.ts";

const globalForPool = globalThis as unknown as { reelplanePool?: Pool };

/** One pool per server process (survives Next dev hot reloads). */
export function db(): Pool {
  globalForPool.reelplanePool ??= createPool(databaseUrlFromEnv(), {
    max: 5,
    applicationName: "reelplane-web",
  });
  return globalForPool.reelplanePool;
}
