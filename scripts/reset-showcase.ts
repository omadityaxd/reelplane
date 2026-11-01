/**
 * `pnpm showcase:reset`: deletes the local demo and bench projects (videos, jobs and events go
 * with them via ON DELETE CASCADE) and their objects in storage, so `showcase:seed` and
 * `bench:seed` can start from scratch. Only touches the dev owner's two seeded projects.
 */
import { createPool, listProjectsForUser, resolveDatabaseUrl, withTenant } from "@reelplane/db";
import { createStorage } from "@reelplane/storage";
import { loadRootEnv } from "./load-env.ts";

loadRootEnv();

const DEV_OWNER_ID = "00000000-0000-4000-8000-000000000001";
const SEEDED = new Set(["Reelplane demo", "Reelplane bench"]);

const pool = createPool(resolveDatabaseUrl(), { max: 1, applicationName: "reelplane-reset" });
const storage = createStorage();
try {
  const projects = (await listProjectsForUser(pool, DEV_OWNER_ID)).filter((p) =>
    SEEDED.has(p.name),
  );
  for (const project of projects) {
    const media = await storage.deletePrefix(`media/${project.id}/`);
    const originals = await storage.deletePrefix(`originals/${project.id}/`);
    await withTenant(pool, { userId: DEV_OWNER_ID }, (client) =>
      client.query("delete from reelplane.projects where id = $1", [project.id]),
    );
    process.stdout.write(`deleted "${project.name}" (${media + originals} objects)\n`);
  }
  if (projects.length === 0) process.stdout.write("nothing to reset\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
