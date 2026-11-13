import { z } from "zod";

/**
 * Response shapes, as zod schemas: the OpenAPI document is generated from them, and
 * test/openapi.test.ts parses real responses with them, so a field added to or dropped from a
 * serializer without updating this file fails the build. Objects are strict for that reason.
 */

const isoDate = z.iso.datetime({ offset: true });
const uuid = z.uuid();

export const errorResponse = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      "unauthorized",
      "forbidden",
      "not_found",
      "invalid_request",
      "conflict",
      "rate_limited",
      "internal_error",
    ]),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export const video = z.strictObject({
  id: uuid,
  status: z.enum(["uploading", "queued", "processing", "ready", "failed", "deleted"]),
  title: z.string().nullable(),
  creatorId: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  failureReason: z.string().nullable(),
  createdAt: isoDate,
  readyAt: isoDate.nullable(),
  playback: z
    .strictObject({
      hlsUrl: z.url().describe("Master HLS playlist."),
      posterUrl: z.url().nullable(),
      placeholder: z.string().nullable().describe("A tiny blurred JPEG as a data: URI."),
    })
    .nullable()
    .describe("Set once the video is ready."),
});

const rendition = z.strictObject({
  name: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  bitrateKbps: z.number().int(),
  fps: z.number().nullable(),
});

export const feedItem = z.strictObject({
  id: uuid,
  title: z.string().nullable(),
  creatorId: z.string().nullable(),
  durationMs: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  likesCount: z.number().int(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: isoDate,
  playback: z.strictObject({
    hlsUrl: z.url().describe("Master playlist starting at 720p (or the best rung below)."),
    hlsLowStartUrl: z.url().describe("The same renditions, starting at the lowest."),
    posterUrl: z.url().nullable(),
    placeholder: z.string().nullable(),
    renditions: z.array(rendition),
    inline: z
      .strictObject({ playlists: z.record(z.url(), z.string()) })
      .optional()
      .describe(
        "First item of a first page only: its master and starting variant playlists, keyed by URL, so the player can skip two round trips.",
      ),
  }),
  score: z
    .strictObject({
      likes: z.number(),
      views: z.number(),
      completions: z.number(),
      completionRate: z.number(),
      ageHours: z.number(),
      value: z.number(),
    })
    .optional()
    .describe("Trending feed with `?explain=1` only."),
});

export const feedPage = z.strictObject({
  data: z.array(feedItem),
  nextCursor: z
    .string()
    .nullable()
    .describe("Pass as `cursor` for the next page; null at the end."),
});

export const videoList = z.strictObject({
  data: z.array(video),
  nextCursor: z.string().nullable(),
});

export const videoResponse = z.strictObject({ data: video });

export const project = z.strictObject({
  data: z.strictObject({
    id: uuid,
    name: z.string(),
    allowedOrigins: z.array(z.string()).optional().describe("Secret key only."),
  }),
});

export const uploadSession = z.strictObject({
  data: z.strictObject({
    video,
    upload: z.strictObject({
      videoId: uuid,
      token: z.string().describe("Upload token for the browser: works only for this video."),
      partSize: z.number().int(),
      partCount: z.number().int(),
      expiresAt: isoDate,
    }),
  }),
});

export const signedParts = z.strictObject({
  data: z.strictObject({
    partSize: z.number().int(),
    partCount: z.number().int(),
    receivedParts: z.array(
      z.strictObject({ partNumber: z.number().int(), size: z.number().int(), etag: z.string() }),
    ),
    urls: z.array(
      z.strictObject({ partNumber: z.number().int(), size: z.number().int(), url: z.url() }),
    ),
    urlsExpireAt: isoDate,
  }),
});

export const deletedVideo = z.strictObject({
  data: z.strictObject({
    id: uuid,
    status: z.literal("deleted"),
    previousStatus: z.string(),
  }),
});

export const like = z.strictObject({
  data: z.strictObject({ videoId: uuid, liked: z.boolean(), likesCount: z.number().int() }),
});

export const report = z.strictObject({
  data: z.strictObject({ videoId: uuid, reported: z.literal(true) }),
});

export const playbackEvents = z.strictObject({
  data: z.strictObject({ accepted: z.number().int(), completionThreshold: z.number() }),
});

export const health = z.strictObject({
  status: z.enum(["ok", "degraded", "rate_limited"]),
  database: z.literal("unreachable").optional(),
});
