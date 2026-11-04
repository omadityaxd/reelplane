import type { Pool } from "./pool.ts";
import { withTenant, withWorker } from "./tenant.ts";

/** What `reelplane.run_cleanup()` did (see migration 0008). */
export interface CleanupReport {
  ran: boolean;
  reason?: string;
  demoVideosDeleted?: number;
  abandonedUploadsDeleted?: number;
  idempotencyKeysDeleted?: number;
  rateLimitWindowsDeleted?: number;
  quotaRowsDeleted?: number;
  /** Multipart uploads of abandoned sessions, for the caller to abort in storage. */
  aborts?: { key: string; uploadId: string }[];
}

/**
 * Runs the cleanup job (as the worker role, like the Go worker does), at most once per
 * `everySeconds` fleet-wide. The daily Vercel cron calls this so demo uploads still expire
 * while no worker is running.
 */
export function runCleanup(pool: Pool, everySeconds: number): Promise<CleanupReport> {
  return withWorker(pool, async (client) => {
    const { rows } = await client.query<{ report: CleanupReport }>(
      "select reelplane.run_cleanup(make_interval(secs => $1)) as report",
      [everySeconds],
    );
    return rows[0]?.report ?? { ran: false, reason: "no result" };
  });
}

export interface GarbageItem {
  prefix: string;
  attempts: number;
}

/**
 * Deletes due storage garbage with `remove` (storage deletePrefix), one batch at a time, the
 * same way the Go worker's sweeper does: rows are claimed with SKIP LOCKED, a failure is retried
 * later with backoff. Returns how many prefixes were removed.
 */
export async function sweepGarbage(
  pool: Pool,
  remove: (prefix: string) => Promise<unknown>,
  batch = 25,
): Promise<number> {
  return withWorker(pool, async (client) => {
    const { rows } = await client.query<GarbageItem>(
      `select prefix, attempts from reelplane.storage_garbage
        where not_before <= now() order by not_before limit $1 for update skip locked`,
      [batch],
    );
    let removed = 0;
    for (const item of rows) {
      try {
        await remove(item.prefix);
        await client.query("delete from reelplane.storage_garbage where prefix = $1", [
          item.prefix,
        ]);
        removed += 1;
      } catch (error) {
        const retryMinutes = Math.min(60, 2 ** item.attempts);
        await client.query(
          `update reelplane.storage_garbage
              set attempts = attempts + 1, last_error = $2,
                  not_before = now() + make_interval(mins => $3)
            where prefix = $1`,
          [item.prefix, String(error).slice(0, 500), retryMinutes],
        );
      }
    }
    return removed;
  });
}

/** When any worker was last alive (null: never), for "uploads are waiting" messages. */
export function workerLastSeen(pool: Pool): Promise<Date | null> {
  return withTenant(pool, {}, async (client) => {
    const { rows } = await client.query<{ seen: Date | null }>(
      "select reelplane.worker_last_seen() as seen",
    );
    return rows[0]?.seen ?? null;
  });
}
