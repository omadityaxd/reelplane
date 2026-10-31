import pg from "pg";

/** Local docker-compose Postgres; used whenever DATABASE_URL is not set. */
export const LOCAL_DATABASE_URL = "postgres://reelplane:reelplane@localhost:54320/reelplane";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface PoolOptions {
  max?: number;
  applicationName?: string;
}

export function resolveDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.DATABASE_URL || LOCAL_DATABASE_URL;
}

export function createPool(
  connectionString = resolveDatabaseUrl(),
  options: PoolOptions = {},
): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? "reelplane",
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client losing its connection must not crash the process; the pool replaces it.
  pool.on("error", () => undefined);
  return pool;
}
