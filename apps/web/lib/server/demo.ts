import "server-only";
import { authenticateApiKey } from "@reelplane/db";
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
