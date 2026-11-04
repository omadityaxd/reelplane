import "server-only";
import { createPool, type Pool } from "@reelplane/db";
import { databaseUrlFromEnv } from "./env.ts";

const globalForPool = globalThis as unknown as { reelplanePool?: Pool };

/**
 * Connections per server process. On Vercel every function instance has its own pool, so keep
 * it small (DATABASE_POOL_MAX=2) and use Supabase's transaction pooler (port 6543).
 */
function poolMax(): number {
  const max = Number(process.env.DATABASE_POOL_MAX ?? 5);
  return Number.isInteger(max) && max > 0 ? max : 5;
}

/** One pool per server process (survives Next dev hot reloads). */
export function db(): Pool {
  globalForPool.reelplanePool ??= createPool(databaseUrlFromEnv(), {
    max: poolMax(),
    applicationName: "reelplane-web",
  });
  return globalForPool.reelplanePool;
}
