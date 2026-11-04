"use server";

import { takeDemoUploadQuota } from "@reelplane/db";
import type { DashboardUploadResult } from "@/app/dashboard/_actions/videos.ts";
import { ACTION_RULES, actionAddress, allowAction } from "@/lib/server/dashboard/limits.ts";
import { requireUser } from "@/lib/server/dashboard/session.ts";
import { DEMO_LIMITS, demoProjectId } from "@/lib/server/demo.ts";
import { ApiError } from "@/lib/server/errors.ts";
import { appDeps } from "@/lib/server/routes.ts";
import { createUploadSchema } from "@/lib/server/uploads/schemas.ts";

const MIB = 1024 * 1024;

import { createUploadSession } from "@/lib/server/uploads/service.ts";

/**
 * "Upload your own reel" on the demo site. Signed-in users only; at most a few per user per
 * day and a cap for the whole demo per day (quotas are taken before the upload starts, under
 * a lock, so they hold under races); size and length limits are the API's (UPLOAD_MAX_BYTES, at most 100 MB; 60 s).
 * Demo uploads are not showcase videos, so the cleanup job deletes them after 7 days.
 */
export async function createDemoUpload(input: unknown): Promise<DashboardUploadResult> {
  const user = await requireUser();
  const projectId = await demoProjectId();
  if (!projectId) return { ok: false, error: "The demo isn't set up on this server." };
  if (
    !(await allowAction(`demo-upload:${await actionAddress()}`, ACTION_RULES.demoUploadPerAddress))
  ) {
    return { ok: false, error: "Too many uploads from your network. Try again in an hour." };
  }
  const parsed = createUploadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "This file type isn't supported (MP4, MOV, WebM or MKV)." };
  }
  try {
    // Validate size and length before spending a quota slot on a file the API would refuse.
    const deps = appDeps();
    if (parsed.data.sizeBytes > deps.limits.maxBytes) {
      return {
        ok: false,
        error: `Videos can be at most ${Math.floor(deps.limits.maxBytes / MIB)} MB.`,
      };
    }
    if ((parsed.data.durationMs ?? 0) > deps.limits.maxDurationMs) {
      return { ok: false, error: "Videos can be at most 60 seconds long." };
    }
    const quota = await takeDemoUploadQuota(deps.pool, projectId, user.id, {
      perUser: DEMO_LIMITS.perUserPerDay,
      perDemo: DEMO_LIMITS.perDemoPerDay,
    });
    if (quota === "user_limit") {
      return {
        ok: false,
        error: `You can upload ${DEMO_LIMITS.perUserPerDay} videos a day to the demo. Come back tomorrow.`,
      };
    }
    if (quota === "demo_limit") {
      return { ok: false, error: "The demo has reached today's upload limit. Come back tomorrow." };
    }
    const session = await createUploadSession(deps, projectId, {
      ...parsed.data,
      creatorId: `user:${user.id}`,
      metadata: {
        credit: "Uploaded by a demo visitor",
        license: "Demo upload, deleted after 7 days",
      },
    });
    return { ok: true, videoId: session.upload.videoId, token: session.upload.token };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, error: error.message };
    throw error;
  }
}
