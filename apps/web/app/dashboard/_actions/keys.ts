"use server";

import { createApiKey, revokeApiKey, rotateApiKey } from "@reelplane/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ACTION_RULES, allowAction } from "@/lib/server/dashboard/limits.ts";
import { requireProject } from "@/lib/server/dashboard/session.ts";
import { db } from "@/lib/server/db.ts";
import { apiKeyPepperFromEnv } from "@/lib/server/env.ts";

const TOO_MANY = "Too many changes in a short time. Wait a minute and try again.";

export type KeyResult = { ok: true; key: string } | { ok: false; error: string };

const createSchema = z.strictObject({
  kind: z.enum(["publishable", "secret"]),
  name: z.string().trim().min(1).max(100),
});
/** Grace periods offered when rotating: the old key keeps working this long. */
const ROTATION_GRACE_SECONDS = [0, 3600, 86_400, 7 * 86_400];
const UUID = z.uuid();

export async function createDashboardKey(projectId: string, input: unknown): Promise<KeyResult> {
  const { user } = await requireProject(projectId);
  if (!(await allowAction(`dashboard:${user.id}`, ACTION_RULES.dashboardWrite)))
    return { ok: false, error: TOO_MANY };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose a kind and a name (1–100 characters)." };
  const created = await createApiKey(db(), { projectId, ...parsed.data }, apiKeyPepperFromEnv());
  revalidatePath(`/dashboard/${projectId}/keys`);
  return { ok: true, key: created.key };
}

export async function rotateDashboardKey(
  projectId: string,
  keyId: string,
  graceSeconds: number,
): Promise<KeyResult> {
  const { user } = await requireProject(projectId);
  if (!(await allowAction(`dashboard:${user.id}`, ACTION_RULES.dashboardWrite)))
    return { ok: false, error: TOO_MANY };
  if (!UUID.safeParse(keyId).success || !ROTATION_GRACE_SECONDS.includes(graceSeconds)) {
    return { ok: false, error: "Invalid key or grace period." };
  }
  const rotated = await rotateApiKey(db(), projectId, keyId, apiKeyPepperFromEnv(), graceSeconds);
  revalidatePath(`/dashboard/${projectId}/keys`);
  return rotated
    ? { ok: true, key: rotated.key }
    : { ok: false, error: "That key is no longer active." };
}

export async function revokeDashboardKey(projectId: string, keyId: string): Promise<void> {
  await requireProject(projectId);
  if (UUID.safeParse(keyId).success) await revokeApiKey(db(), projectId, keyId);
  revalidatePath(`/dashboard/${projectId}/keys`);
}
