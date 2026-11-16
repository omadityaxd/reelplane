import pg from "pg";
import { SUPABASE_ROOT_CA } from "./supabase-ca.ts";

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

const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "[::1]"]);
/** Parameters that would make `pg` replace the `ssl` option built below. */
const SSL_PARAMS = ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"];

/**
 * How to connect to `connectionString`: a database on this machine as given, anything else only
 * over TLS with a verified certificate. `pg` encrypts only when asked to (and its
 * `sslmode=require` fails on Supabase, whose CA is not a public one), so without this a remote
 * DATABASE_URL would silently run in plain text. Supabase hosts are verified against Supabase's
 * root CA, others against the system's. `sslmode=disable` in the URL is the explicit opt-out
 * (e.g. a Postgres container reached by its service name).
 */
export function connectionConfig(connectionString: string): pg.ClientConfig {
  const url = new URL(connectionString);
  if (LOCAL_HOSTS.has(url.hostname) || url.searchParams.get("sslmode") === "disable") {
    return { connectionString };
  }
  for (const param of SSL_PARAMS) url.searchParams.delete(param);
  const supabase = /\.supabase\.(co|com)$/.test(url.hostname);
  return {
    connectionString: url.toString(),
    ssl: supabase ? { ca: SUPABASE_ROOT_CA } : { rejectUnauthorized: true },
  };
}

export function createPool(
  connectionString = resolveDatabaseUrl(),
  options: PoolOptions = {},
): Pool {
  const pool = new pg.Pool({
    ...connectionConfig(connectionString),
    max: options.max ?? 10,
    application_name: options.applicationName ?? "reelplane",
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client losing its connection must not crash the process; the pool replaces it.
  pool.on("error", () => undefined);
  return pool;
}
