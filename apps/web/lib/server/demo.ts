import "server-only";
import { authenticateApiKey, workerLastSeen } from "@reelplane/db";
import { db } from "./db.ts";
import { apiKeyPepperFromEnv } from "./env.ts";

/** Demo guardrails (the brief's): small daily caps; uploads are deleted after 7 days. */
export const DEMO_LIMITS = {
  perUserPerDay: Number(process.env.DEMO_UPLOADS_PER_USER_PER_DAY ?? 3),
  perDemoPerDay: Number(process.env.DEMO_UPLOADS_PER_DAY ?? 50),
};

let demoProject: Promise<string | null> | undefined;

/** The demo site's project: the one NEXT_PUBLIC_DEMO_PUBLISHABLE_KEY belongs to. */
export function demoProjectId(): Promise<string | null> {
  const key = process.env.NEXT_PUBLIC_DEMO_PUBLISHABLE_KEY;
  if (!key) return Promise.resolve(null);
  demoProject ??= authenticateApiKey(db(), key, apiKeyPepperFromEnv()).then(
    (auth) => auth?.projectId ?? null,
  );
  return demoProject;
}

/** A worker stamps its presence every ~20 s; older than this, treat it as off. */
const WORKER_ONLINE_WITHIN_MS = 2 * 60_000;

/**
 * Whether a transcoding worker is running. The demo's worker runs on the author's laptop, so
 * it is often off: uploads then wait in the queue, and the pages say so.
 */
export async function workerOnline(): Promise<boolean> {
  try {
    const seen = await workerLastSeen(db());
    return seen !== null && Date.now() - seen.getTime() < WORKER_ONLINE_WITHIN_MS;
  } catch {
    return false;
  }
}
