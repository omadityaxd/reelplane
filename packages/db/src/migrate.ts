import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Pool } from "./pool.ts";

/**
 * Exposed as `@reelplane/db/migrate`, deliberately not from the main entry: only scripts and
 * tests run migrations, and bundlers (the Next.js server build) cannot resolve this file path.
 */
export const MIGRATIONS_DIR = resolve(import.meta.dirname, "..", "migrations");

/** Arbitrary constant: serialises concurrent migrators (two deploys, a test run) on one DB. */
const MIGRATION_LOCK_ID = 7_302_514_001;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

interface MigrationFile {
  version: string;
  sql: string;
  checksum: string;
}

async function readMigrations(dir: string): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((name) => /^\d{4}_[\w-]+\.sql$/.test(name)).sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(dir, name), "utf8");
      return {
        version: name.replace(/\.sql$/, ""),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

/**
 * Applies pending SQL migrations in order, each in its own transaction. Refuses to run if an
 * already-applied migration file was edited (checksum mismatch): migrations are append-only.
 */
export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const migrations = await readMigrations(dir);
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query("create schema if not exists reelplane");
    await client.query(`
      create table if not exists reelplane.schema_migrations (
        version    text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`);

    const { rows } = await client.query<{ version: string; checksum: string }>(
      "select version, checksum from reelplane.schema_migrations",
    );
    const appliedChecksums = new Map(rows.map((row) => [row.version, row.checksum]));
    const result: MigrationResult = { applied: [], skipped: [] };

    for (const migration of migrations) {
      const existing = appliedChecksums.get(migration.version);
      if (existing !== undefined) {
        if (existing !== migration.checksum) {
          throw new Error(
            `Migration ${migration.version} was modified after being applied. ` +
              "Add a new migration instead of editing an old one.",
          );
        }
        result.skipped.push(migration.version);
        continue;
      }
      try {
        await client.query("begin");
        await client.query(migration.sql);
        await client.query(
          "insert into reelplane.schema_migrations (version, checksum) values ($1, $2)",
          [migration.version, migration.checksum],
        );
        await client.query("commit");
        result.applied.push(migration.version);
      } catch (error) {
        await client.query("rollback");
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${migration.version} failed: ${detail}`, { cause: error });
      }
    }
    return result;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
