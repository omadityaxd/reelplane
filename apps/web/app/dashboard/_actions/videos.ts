"use server";

import { deleteVideo, unhideVideo } from "@reelplane/db";
import { revalidatePath } from "next/cache";
import { ACTION_RULES, allowAction } from "@/lib/server/dashboard/limits.ts";
import { requireProject } from "@/lib/server/dashboard/session.ts";
import { ApiError } from "@/lib/server/errors.ts";
import { appDeps } from "@/lib/server/routes.ts";
import { createUploadSchema } from "@/lib/server/uploads/schemas.ts";
import { createUploadSession } from "@/lib/server/uploads/service.ts";

const TOO_MANY = "Too many changes in a short time. Wait a minute and try again.";

export type DashboardUploadResult =
  | { ok: true; videoId: string; token: string }
  | { ok: false; error: string };

/**
 * Starts an upload for the dashboard's upload button: the same session the API creates for a
 * secret key, so the browser then uploads straight to storage with the upload token.
 */
export async function createDashboardUpload(
  projectId: string,
  input: unknown,
): Promise<DashboardUploadResult> {
  const { user } = await requireProject(projectId);
  if (!(await allowAction(`dashboard:${user.id}`, ACTION_RULES.dashboardWrite)))
    return { ok: false, error: TOO_MANY };
  const parsed = createUploadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "This file type isn't supported (MP4, MOV, WebM or MKV)." };
  }
  try {
    const session = await createUploadSession(appDeps(), projectId, parsed.data);
    return { ok: true, videoId: session.upload.videoId, token: session.upload.token };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function deleteDashboardVideo(projectId: string, videoId: string): Promise<void> {
  await requireProject(projectId);
  await deleteVideo(appDeps().pool, projectId, videoId);
  revalidatePath(`/dashboard/${projectId}`, "layout");
}

/** Shows a video that viewer reports hid from feeds again (after the owner reviewed it). */
export async function unhideDashboardVideo(projectId: string, videoId: string): Promise<void> {
  await requireProject(projectId);
  await unhideVideo(appDeps().pool, projectId, videoId);
  revalidatePath(`/dashboard/${projectId}`, "layout");
}
