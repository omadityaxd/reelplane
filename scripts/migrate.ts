/** `pnpm db:migrate`: applies pending SQL migrations to DATABASE_URL (or local Postgres). */
import { createPool, resolveDatabaseUrl } from "@reelplane/db";
import { migrate } from "@reelplane/db/migrate";
import { loadRootEnv } from "./load-env.ts";

loadRootEnv();

const pool = createPool(resolveDatabaseUrl(), { max: 1, applicationName: "reelplane-migrate" });
try {
  const result = await migrate(pool);
  const applied = result.applied.length > 0 ? result.applied.join(", ") : "none";
  process.stdout.write(`Applied: ${applied} (${result.skipped.length} already up to date)\n`);
} catch (error) {
  // A refused connection is an AggregateError with an empty message: say what failed.
  const message =
    error instanceof AggregateError
      ? error.errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")
      : error instanceof Error
        ? error.message
        : String(error);
  process.stderr.write(`Migration failed: ${message || "unknown error"}\n`);
  if (message.includes("ECONNREFUSED")) {
    process.stderr.write("Is Postgres running? Try `pnpm infra:up` (or check DATABASE_URL).\n");
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
