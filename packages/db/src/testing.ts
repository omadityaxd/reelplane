import pg from "pg";
import { migrate } from "./migrate.ts";
import { createPool, resolveDatabaseUrl } from "./pool.ts";

/**
 * Creates (or recreates) a throwaway database next to the configured one and migrates it.
 * Each package uses its own name so `pnpm -r test` never shares state between packages.
 */
export async function createTestDatabase(name: string): Promise<string> {
  if (!/^reelplane_test_[a-z0-9_]+$/.test(name)) {
    throw new Error(`refusing to recreate non-test database "${name}"`);
  }
  const baseUrl = process.env.TEST_DATABASE_ADMIN_URL || resolveDatabaseUrl();
  const admin = new pg.Client({ connectionString: baseUrl, connectionTimeoutMillis: 5000 });
  try {
    await admin.connect();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Tests need Postgres at ${new URL(baseUrl).host} (${detail}). Start it with \`pnpm infra:up\`.`,
      { cause: error },
    );
  }
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), { max: 1 });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  return url.toString();
}
