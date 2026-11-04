import { runCleanup, sweepGarbage } from "@reelplane/db";
import { cronAuthError } from "@/lib/server/cron.ts";
import { appDeps } from "@/lib/server/routes.ts";

export const dynamic = "force-dynamic";
/** Vercel Hobby functions may run up to 60 s; the sweep stops well before that. */
export const maxDuration = 60;
const SWEEP_BUDGET_MS = 40_000;

/**
 * Daily cleanup (vercel.json cron), so demo uploads expire and their files go even while no
 * worker is running. Same job as the worker's housekeeping: expired demo uploads, abandoned
 * upload sessions (multipart aborted), old idempotency keys and counters, then storage garbage.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET`; anything else is refused.
 */
export async function GET(request: Request): Promise<Response> {
  const refused = cronAuthError(request, process.env.CRON_SECRET);
  if (refused) return refused;
  const deps = appDeps();
  // Skipped if a worker already ran it within the last hour.
  const report = await runCleanup(deps.pool, 3600);
  let aborted = 0;
  for (const upload of report.aborts ?? []) {
    try {
      await deps.storage.abortMultipartUpload(upload.key, upload.uploadId);
      aborted += 1;
    } catch {
      // Already gone or never started: nothing left to free.
    }
  }
  const started = Date.now();
  let swept = 0;
  for (;;) {
    const removed = await sweepGarbage(deps.pool, (prefix) => deps.storage.deletePrefix(prefix));
    swept += removed;
    if (removed === 0 || Date.now() - started > SWEEP_BUDGET_MS) break;
  }
  const { aborts: _aborts, ...summary } = report;
  return Response.json({ ...summary, multipartAborted: aborted, garbagePrefixesSwept: swept });
}
