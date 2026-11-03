/**
 * `pnpm loadtest [k6 args]`: runs loadtest/feed-and-uploads.js against the running app with the
 * bench project's publishable key and a temporary secret key, revoked afterwards.
 * Start the app with RATE_LIMIT_SCALE=1000 to measure throughput rather than the limits.
 */
import { spawnSync } from "node:child_process";
import {
  createApiKey,
  createPool,
  listProjectsForUser,
  resolveDatabaseUrl,
  resolvePepper,
  revokeApiKey,
} from "@reelplane/db";
import { loadRootEnv } from "./load-env.ts";

loadRootEnv();
process.loadEnvFile?.("apps/web/.env.local");

const DEV_OWNER_ID = "00000000-0000-4000-8000-000000000001";
const pool = createPool(resolveDatabaseUrl(), { max: 1, applicationName: "reelplane-loadtest" });
try {
  const bench = (await listProjectsForUser(pool, DEV_OWNER_ID)).find(
    (p) => p.name === "Reelplane bench",
  );
  const pk = process.env.NEXT_PUBLIC_BENCH_PUBLISHABLE_KEY;
  if (!bench || !pk) throw new Error("Run `pnpm bench:seed` first (the feed needs videos).");
  const origin = bench.allowedOrigins[0] ?? "http://localhost:3000";
  const secret = await createApiKey(
    pool,
    { projectId: bench.id, kind: "secret", name: "k6 load test" },
    resolvePepper(),
  );
  // It expires by itself within the hour, even if this script is killed before revoking it.
  await pool.query(
    "update reelplane.api_keys set expires_at = now() + interval '1 hour' where id = $1",
    [secret.record.id],
  );
  try {
    // K6 overrides the binary (e.g. the portable release in .tools/k6/k6.exe).
    const k6 = process.env.K6 ?? "k6";
    const result = spawnSync(
      k6,
      ["run", ...process.argv.slice(2), "loadtest/feed-and-uploads.js"],
      {
        stdio: "inherit",
        env: { ...process.env, PK: pk, SK: secret.key, ORIGIN: origin },
      },
    );
    if (result.error) process.stderr.write(`could not run ${k6}: ${result.error.message}\n`);
    process.exitCode = result.status ?? 1;
  } finally {
    await revokeApiKey(pool, bench.id, secret.record.id);
  }
} finally {
  await pool.end();
}
