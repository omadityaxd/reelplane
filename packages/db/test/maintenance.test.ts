import { describe, expect, it } from "vitest";
import { runCleanup, sweepGarbage, withWorker, workerLastSeen } from "../src/index.ts";
import { useTestPool } from "./helpers.ts";

const pool = useTestPool();

describe("maintenance from the web app (daily cron)", () => {
  it("runs the cleanup job at most once per interval", async () => {
    await pool.query("delete from reelplane.maintenance where task = 'cleanup'");
    const first = await runCleanup(pool, 3600);
    const second = await runCleanup(pool, 3600);
    expect(first.ran).toBe(true);
    expect(second).toMatchObject({ ran: false, reason: "ran recently" });
  });

  it("sweeps due garbage, and backs off a prefix whose delete failed", async () => {
    const ok = `media/00000000-0000-4000-8000-00000000000a/${crypto.randomUUID()}/`;
    const broken = `media/00000000-0000-4000-8000-00000000000b/${crypto.randomUUID()}/`;
    await withWorker(pool, (client) =>
      client.query(
        `insert into reelplane.storage_garbage (prefix, reason, not_before)
         values ($1, 'test', now() - interval '1 minute'), ($2, 'test', now() - interval '1 minute')`,
        [ok, broken],
      ),
    );
    const removed: string[] = [];
    await sweepGarbage(pool, async (prefix) => {
      if (prefix === broken) throw new Error("storage down");
      if (prefix === ok) removed.push(prefix);
    });
    expect(removed).toEqual([ok]);
    const { rows } = await pool.query(
      "select prefix, attempts, not_before > now() as later, last_error from reelplane.storage_garbage where prefix = any($1)",
      [[ok, broken]],
    );
    expect(rows).toEqual([
      { prefix: broken, attempts: 1, later: true, last_error: "Error: storage down" },
    ]);
    await pool.query("delete from reelplane.storage_garbage where prefix = $1", [broken]);
  });

  it("reports when a worker was last seen", async () => {
    await withWorker(pool, (client) => client.query("select reelplane.worker_seen()"));
    const seen = await workerLastSeen(pool);
    expect(seen && Date.now() - seen.getTime()).toBeLessThan(10_000);
  });
});
