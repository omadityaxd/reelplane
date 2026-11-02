"use server";

import { createProject, normalizeOrigin, renameProject, setAllowedOrigins } from "@reelplane/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireProject, requireUser } from "@/lib/server/dashboard/session.ts";
import { db } from "@/lib/server/db.ts";
import { apiKeyPepperFromEnv } from "@/lib/server/env.ts";

export interface CreatedProjectState {
  error: string | null;
  created: { projectId: string; name: string; publishableKey: string; secretKey: string } | null;
}

const MAX_ORIGINS = 20;
const nameSchema = z.string().trim().min(1, "Give the project a name.").max(100);

/** Creates a project with one publishable and one secret key, shown once. */
export async function createDashboardProject(
  _previous: CreatedProjectState,
  form: FormData,
): Promise<CreatedProjectState> {
  const user = await requireUser();
  const name = nameSchema.safeParse(form.get("name"));
  if (!name.success)
    return { error: name.error.issues[0]?.message ?? "Invalid name.", created: null };
  const created = await createProject(
    db(),
    { ownerId: user.id, name: name.data },
    apiKeyPepperFromEnv(),
  );
  revalidatePath("/dashboard");
  return {
    error: null,
    created: {
      projectId: created.project.id,
      name: created.project.name,
      publishableKey: created.publishableKey.key,
      secretKey: created.secretKey.key,
    },
  };
}

export interface SettingsState {
  error: string | null;
  saved: boolean;
}

/** Renames the project and replaces its allowed browser origins (one per line). */
export async function saveProjectSettings(
  projectId: string,
  _previous: SettingsState,
  form: FormData,
): Promise<SettingsState> {
  const { user } = await requireProject(projectId);
  const name = nameSchema.safeParse(form.get("name"));
  if (!name.success)
    return { error: name.error.issues[0]?.message ?? "Invalid name.", saved: false };
  const lines = String(form.get("origins") ?? "")
    .split(/\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > MAX_ORIGINS) return { error: `At most ${MAX_ORIGINS} origins.`, saved: false };
  const origins: string[] = [];
  for (const line of lines) {
    try {
      origins.push(normalizeOrigin(line));
    } catch {
      return { error: `Not an http(s) origin: ${line}`, saved: false };
    }
  }
  await renameProject(db(), user.id, projectId, name.data);
  await setAllowedOrigins(db(), user.id, projectId, origins);
  revalidatePath(`/dashboard/${projectId}`, "layout");
  return { error: null, saved: true };
}
