import { createHmac } from "node:crypto";
import {
  COMPLETION_THRESHOLD,
  type FeedSpec,
  type FeedVideo,
  getFeed,
  REPORT_REASONS,
  recordPlaybackEvents,
  reportVideo,
  setLike,
} from "@reelplane/db";
import type { ObjectStorage } from "@reelplane/storage";
import { z } from "zod";
import { json, readJson } from "../api-route.ts";
import { MemoryCache } from "../cache.ts";
import type { AppDeps } from "../deps.ts";
import { endpoint } from "../endpoint.ts";
import { ApiError } from "../errors.ts";
import { clientAddress, RULES } from "../rate-limit.ts";
import { parseBody } from "../uploads/schemas.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Hot feed pages are cached briefly; a new video appears within this many ms. */
export const FEED_CACHE_TTL_MS = 10_000;
const feedCache = new MemoryCache();

export interface PublicFeedVideo {
  id: string;
  title: string | null;
  creatorId: string | null;
  durationMs: number;
  width: number;
  height: number;
  likesCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  playback: {
    /** Master playlist starting at 720p (or the best rung below): for fast or unknown networks. */
    hlsUrl: string;
    /** The same renditions, starting at the lowest: for slow networks (native HLS starts on
     *  the first variant listed, so the start quality is chosen by picking the playlist). */
    hlsLowStartUrl: string;
    posterUrl: string | null;
    placeholder: string | null;
    renditions: FeedVideo["renditions"];
  };
  score?: FeedVideo["score"];
}

function serializeFeedVideo(
  video: FeedVideo,
  storage: ObjectStorage,
  explain: boolean,
): PublicFeedVideo {
  return {
    id: video.id,
    title: video.title,
    creatorId: video.creatorId,
    durationMs: video.durationMs,
    width: video.width,
    height: video.height,
    likesCount: video.likesCount,
    metadata: video.metadata,
    createdAt: video.readyAt.toISOString(),
    playback: {
      hlsUrl: storage.publicUrl(video.masterPlaylistKey),
      hlsLowStartUrl: storage.publicUrl(lowStartKey(video.masterPlaylistKey)),
      posterUrl: video.posterKey ? storage.publicUrl(video.posterKey) : null,
      placeholder: video.placeholder,
      renditions: video.renditions,
    },
    ...(explain && video.score ? { score: video.score } : {}),
  };
}

/** The worker writes master_low.m3u8 next to master.m3u8 (services/worker/internal/media). */
function lowStartKey(masterKey: string): string {
  return masterKey.replace(/master\.m3u8$/, "master_low.m3u8");
}

/** `latest`, `trending`, or `creator:<creatorId>`. */
export function parseFeed(raw: string): FeedSpec {
  const decoded = decodeURIComponent(raw);
  if (decoded === "latest" || decoded === "trending") return { kind: decoded };
  if (decoded.startsWith("creator:")) {
    const creatorId = decoded.slice("creator:".length);
    if (creatorId.length >= 1 && creatorId.length <= 200) return { kind: "creator", creatorId };
  }
  throw new ApiError("not_found", "Unknown feed. Use latest, trending or creator:<creatorId>.");
}

export const feedQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(30).default(10),
  cursor: z.string().max(500).optional(),
  explain: z.enum(["1", "true"]).optional(),
});

/**
 * The first page of a feed for a server-rendered page (`<ReelFeed initialPage>`): the same
 * items the API returns, through the same cache.
 */
export async function firstFeedPage(
  deps: AppDeps,
  projectId: string,
  feed: FeedSpec,
  limit: number,
): Promise<{ items: unknown[]; nextCursor: string | null }> {
  const cacheKey = JSON.stringify([projectId, feed, limit, "", false]);
  const cached = feedCache.get<{ data: unknown[]; nextCursor: string | null }>(cacheKey);
  if (cached) return { items: cached.data, nextCursor: cached.nextCursor };
  const page = await getFeed(deps.pool, { projectId, feed, limit });
  const body = {
    data: page.videos.map((video) => serializeFeedVideo(video, deps.storage, false)),
    nextCursor: page.nextCursor,
  };
  feedCache.set(cacheKey, body, FEED_CACHE_TTL_MS);
  return { items: body.data, nextCursor: body.nextCursor };
}

/**
 * GET /v1/feeds/:feed — a page of ready videos for the player. Works with a publishable key
 * from the project's allowed origins. Pages are cached for 10 s per server instance.
 */
export const getFeedPage = endpoint(
  { allow: ["publishable", "secret"], rateLimit: RULES.feed },
  async ({ request, auth, deps, params }) => {
    const feed = parseFeed(params.feed ?? "");
    const query = parseBody(feedQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    const explain = query.explain !== undefined;
    const cacheKey = JSON.stringify([
      auth.projectId,
      feed,
      query.limit,
      query.cursor ?? "",
      explain,
    ]);
    const cached = feedCache.get<unknown>(cacheKey);
    if (cached) return json(cached, { headers: { "x-cache": "hit" } });

    try {
      const page = await getFeed(deps.pool, {
        projectId: auth.projectId,
        feed,
        limit: query.limit,
        cursor: query.cursor,
      });
      const body = {
        data: page.videos.map((video) => serializeFeedVideo(video, deps.storage, explain)),
        nextCursor: page.nextCursor,
      };
      feedCache.set(cacheKey, body, FEED_CACHE_TTL_MS);
      return json(body, { headers: { "x-cache": "miss" } });
    } catch (error) {
      if (error instanceof RangeError) throw new ApiError("invalid_request", "Invalid cursor.");
      throw error;
    }
  },
);

const eventSchema = z.strictObject({
  videoId: z.string().regex(UUID),
  sessionId: z.string().min(1).max(100),
  type: z.enum(["ttff", "rebuffer", "watch", "quality_switch", "error"]),
  valueMs: z.number().int().min(0).max(3_600_000).optional(),
  data: z
    .record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
    .refine((value) => Object.keys(value).length <= 20, "at most 20 data keys")
    .optional(),
});
export const eventsSchema = z.strictObject({ events: z.array(eventSchema).min(1).max(100) });

/**
 * POST /v1/playback-events — batched quality metrics from the SDK. Also accepts the publishable
 * key as `?key=`, because the final flush on page unload cannot send an Authorization header.
 */
export const ingestPlaybackEvents = endpoint(
  { allow: ["publishable", "secret"], allowQueryKey: true, rateLimit: RULES.playbackEvents },
  async ({ request, auth, deps }) => {
    const { events } = parseBody(eventsSchema, await readJson(request));
    const accepted = await recordPlaybackEvents(deps.pool, auth.projectId, events);
    return json({ data: { accepted, completionThreshold: COMPLETION_THRESHOLD } }, { status: 202 });
  },
);

export const likeSchema = z.strictObject({ viewerId: z.string().trim().min(1).max(200) });

function likeEndpoint(liked: boolean) {
  return endpoint(
    { allow: ["publishable", "secret"], rateLimit: RULES.like },
    async ({ request, auth, deps, params }) => {
      const id = params.id ?? "";
      const { viewerId } = parseBody(likeSchema, await readJson(request));
      const likesCount = UUID.test(id)
        ? await setLike(deps.pool, auth.projectId, id, viewerId, liked)
        : null;
      if (likesCount === null) throw new ApiError("not_found", "Video not found.");
      return json({ data: { videoId: id, liked, likesCount } });
    },
  );
}

/** POST /v1/videos/:id/likes and DELETE — idempotent per (video, viewerId). */
export const likeVideo = likeEndpoint(true);
export const unlikeVideo = likeEndpoint(false);

export const reportSchema = z.strictObject({ reason: z.enum(REPORT_REASONS) });

/**
 * POST /v1/videos/:id/reports — a viewer reports a video (the feed's report button). Each
 * address counts once per video, stored only as an HMAC; three reports hide it from feeds.
 */
export const reportFeedVideo = endpoint(
  { allow: ["publishable", "secret"], rateLimit: RULES.report },
  async ({ request, auth, deps, params }) => {
    const id = params.id ?? "";
    const { reason } = parseBody(reportSchema, await readJson(request));
    const reporter = createHmac("sha256", deps.pepper)
      .update(`report:${auth.projectId}:${clientAddress(request)}`)
      .digest("base64url");
    const found = UUID.test(id)
      ? await reportVideo(deps.pool, auth.projectId, id, reporter, reason)
      : false;
    if (!found) throw new ApiError("not_found", "Video not found.");
    return json({ data: { videoId: id, reported: true } }, { status: 202 });
  },
);
