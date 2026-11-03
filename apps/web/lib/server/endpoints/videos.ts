import { deleteVideo, getProject, getVideo, listVideos, type VideoStatus } from "@reelplane/db";
import { z } from "zod";
import { json } from "../api-route.ts";
import { endpoint } from "../endpoint.ts";
import { ApiError } from "../errors.ts";
import { RULES } from "../rate-limit.ts";
import { parseBody } from "../uploads/schemas.ts";
import { serializeVideo } from "../videos/serialize.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LISTABLE_STATUSES = [
  "uploading",
  "queued",
  "processing",
  "ready",
  "failed",
] as const satisfies readonly VideoStatus[];

const listQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
  status: z.enum(LISTABLE_STATUSES).optional(),
});

/** GET /v1/project — the project the API key belongs to. Works with either key kind. */
export const getCurrentProject = endpoint(
  { allow: ["secret", "publishable"], rateLimit: RULES.project },
  async ({ auth, deps }) => {
    const project = await getProject(deps.pool, auth.projectId);
    if (!project) throw new ApiError("not_found", "Project not found.");
    return json({
      data: {
        id: project.id,
        name: project.name,
        // Allowed origins are configuration a secret-key holder manages; not for browsers.
        ...(auth.credential === "secret" ? { allowedOrigins: project.allowedOrigins } : {}),
      },
    });
  },
);

/** GET /v1/videos — the project's videos, newest first, cursor-paginated (secret key). */
export const listProjectVideos = endpoint(
  { allow: ["secret"], rateLimit: RULES.readVideos },
  async ({ request, auth, deps }) => {
    const query = parseBody(listQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    try {
      const page = await listVideos(deps.pool, { projectId: auth.projectId, ...query });
      return json({
        data: page.videos.map((video) => serializeVideo(video, deps.storage)),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (error instanceof RangeError) throw new ApiError("invalid_request", "Invalid cursor.");
      throw error;
    }
  },
);

/** GET /v1/videos/:id — one video with its status and, once ready, playback URLs. */
export const getProjectVideo = endpoint(
  { allow: ["secret"], rateLimit: RULES.readVideos },
  async ({ auth, deps, params }) => {
    const id = params.id ?? "";
    // RLS already hides other projects' videos; a malformed id is simply not found.
    const video = UUID.test(id) ? await getVideo(deps.pool, auth.projectId, id) : null;
    if (!video || video.status === "deleted") throw new ApiError("not_found", "Video not found.");
    return json({ data: serializeVideo(video, deps.storage) });
  },
);

/**
 * DELETE /v1/videos/:id — deletes a video at any stage: it leaves feeds at once, a queued job is
 * cancelled, `video.deleted` is sent to webhooks, and its stored files are removed by the
 * worker shortly after. Deleting it again answers 404.
 */
export const deleteProjectVideo = endpoint(
  { allow: ["secret"], rateLimit: RULES.deleteVideo },
  async ({ auth, deps, params }) => {
    const id = params.id ?? "";
    const previous = UUID.test(id) ? await deleteVideo(deps.pool, auth.projectId, id) : null;
    if (!previous) throw new ApiError("not_found", "Video not found.");
    return json({ data: { id, status: "deleted", previousStatus: previous } });
  },
);
