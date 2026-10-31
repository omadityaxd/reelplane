/**
 * `pnpm db:seed`: creates a local development project and prints its keys once.
 * Keys cannot be shown again (only hashes are stored), so copy them into apps/web/.env.local.
 */
import { createPool, createProject, resolveDatabaseUrl, resolvePepper } from "@reelplane/db";
import { loadRootEnv } from "./load-env.ts";

loadRootEnv();

/** Stable fake dashboard user for local development (real users come from Supabase Auth). */
const DEV_OWNER_ID = "00000000-0000-4000-8000-000000000001";

const pool = createPool(resolveDatabaseUrl(), { max: 1, applicationName: "reelplane-seed" });
try {
  const { project, publishableKey, secretKey } = await createProject(
    pool,
    {
      ownerId: DEV_OWNER_ID,
      name: "Local development",
      allowedOrigins: ["http://localhost:3000"],
      isDemo: true,
    },
    resolvePepper(),
  );
  process.stdout.write(
    [
      `Project ${project.id} created. These keys are shown ONCE:`,
      `  publishable: ${publishableKey.key}`,
      `  secret:      ${secretKey.key}`,
      "",
      'Try: curl -H "Authorization: Bearer <secret>" http://localhost:3000/v1/project',
      "",
    ].join("\n"),
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
