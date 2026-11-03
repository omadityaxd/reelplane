import "server-only";
import { headers } from "next/headers";
import { db } from "../db.ts";
import { clientAddress, PostgresRateLimiter } from "../rate-limit.ts";

const HOUR = 3600;

/** Limits for things that are not API routes: sign-in emails and dashboard writes. */
export const ACTION_RULES = {
  /** Magic-link emails cost real sends (and Supabase caps them): per address and per inbox. */
  signInPerAddress: { limit: 10, windowSeconds: HOUR },
  signInPerEmail: { limit: 3, windowSeconds: HOUR },
  /** Creating keys, webhooks, projects and uploads, per signed-in user. */
  dashboardWrite: { limit: 30, windowSeconds: 60 },
  demoUploadPerAddress: { limit: 10, windowSeconds: HOUR },
} as const;

/** The calling browser's address inside a server action. */
export async function actionAddress(): Promise<string> {
  const h = await headers();
  return clientAddress(new Request("http://action.local", { headers: h }));
}

/** Counts a hit; false when over the limit. */
export async function allowAction(
  bucket: string,
  rule: { limit: number; windowSeconds: number },
): Promise<boolean> {
  const result = await new PostgresRateLimiter(db()).hit(bucket, rule.limit, rule.windowSeconds);
  return result.allowed;
}
