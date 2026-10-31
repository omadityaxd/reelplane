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
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
