import { z } from "zod";
import type { Credential } from "../auth.ts";
import type { Endpoint } from "../endpoint.ts";
import * as feeds from "../endpoints/feeds.ts";
import * as uploads from "../endpoints/uploads.ts";
import * as videos from "../endpoints/videos.ts";
import { CLIENT_RULE } from "../rate-limit.ts";
import { completeUploadSchema, createUploadSchema, signPartsSchema } from "../uploads/schemas.ts";
import * as responses from "./responses.ts";

/**
 * The public API as data. Every operation points at the `endpoint` its route file binds, and
 * everything that can be read from code is: who may call it (`allow`), its rate limit, and its
 * request and response schemas. Only summaries and descriptions are written by hand.
 * test/openapi.test.ts checks this list against app/v1/**\/route.ts, and real responses against
 * the response schemas, so the document cannot drift from the code.
 */
export type HttpMethod = "GET" | "POST" | "DELETE";

export interface Operation {
  method: HttpMethod;
  path: string;
  /** The endpoint the route binds; absent for /v1/health, which takes no credentials. */
  endpoint?: Endpoint;
  operationId: string;
  tag: "Feeds" | "Uploads" | "Videos" | "Project" | "Health";
  summary: string;
  description: string;
  pathParams?: Record<string, string>;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Honours an `Idempotency-Key` header. */
  idempotent?: boolean;
  success: { status: number; description: string; schema: z.ZodType; component: string };
}

const VIDEO_ID = { id: "The video's id (a UUID)." };

export const OPERATIONS: Operation[] = [
  {
    method: "GET",
    path: "/v1/feeds/{feed}",
    endpoint: feeds.getFeedPage,
    operationId: "getFeed",
    tag: "Feeds",
    summary: "Get a page of a feed",
    description:
      "Ready videos for the player, with HLS URLs. Call it from the browser with a publishable key (from one of the project's allowed origins). Pages are cached for 10 seconds per server.",
    pathParams: {
      feed: "`latest`, `trending`, or `creator:<creatorId>`.",
    },
    query: feeds.feedQuerySchema,
    success: {
      status: 200,
      description: "A page of the feed.",
      schema: responses.feedPage,
      component: "FeedPage",
    },
  },
  {
    method: "POST",
    path: "/v1/playback-events",
    endpoint: feeds.ingestPlaybackEvents,
    operationId: "sendPlaybackEvents",
    tag: "Feeds",
    summary: "Send playback metrics",
    description:
      "Batched quality metrics from the player SDK: time to first frame, rebuffers, watch time, quality switches and errors. The SDK sends these for you. The key may also go in `?key=`, because a request sent as the page unloads cannot set headers.",
    body: feeds.eventsSchema,
    success: {
      status: 202,
      description: "Accepted.",
      schema: responses.playbackEvents,
      component: "PlaybackEventsAccepted",
    },
  },
  {
    method: "POST",
    path: "/v1/videos/{id}/likes",
    endpoint: feeds.likeVideo,
    operationId: "likeVideo",
    tag: "Feeds",
    summary: "Like a video",
    description: "Idempotent per video and `viewerId`: liking twice counts once.",
    pathParams: VIDEO_ID,
    body: feeds.likeSchema,
    success: {
      status: 200,
      description: "The new like count.",
      schema: responses.like,
      component: "Like",
    },
  },
  {
    method: "DELETE",
    path: "/v1/videos/{id}/likes",
    endpoint: feeds.unlikeVideo,
    operationId: "unlikeVideo",
    tag: "Feeds",
    summary: "Remove a like",
    description: "Idempotent per video and `viewerId`.",
    pathParams: VIDEO_ID,
    body: feeds.likeSchema,
    success: {
      status: 200,
      description: "The new like count.",
      schema: responses.like,
      component: "Like",
    },
  },
  {
    method: "POST",
    path: "/v1/videos/{id}/reports",
    endpoint: feeds.reportFeedVideo,
    operationId: "reportVideo",
    tag: "Feeds",
    summary: "Report a video",
    description:
      "A viewer reports a video. Each address counts once per video (stored only as an HMAC). Three reports hide the video from feeds until it is reviewed in the dashboard.",
    pathParams: VIDEO_ID,
    body: feeds.reportSchema,
    success: {
      status: 202,
      description: "Recorded.",
      schema: responses.report,
      component: "Report",
    },
  },
  {
    method: "POST",
    path: "/v1/uploads",
    endpoint: uploads.createUpload,
    operationId: "createUpload",
    tag: "Uploads",
    summary: "Start an upload",
    description:
      "Creates the video and a multipart upload in storage, and returns an upload token for the browser. Call it from your server. The video bytes never pass through the API: the browser sends them straight to storage (`@reelplane/sdk-core`'s `uploadVideo` does all of it).",
    body: createUploadSchema,
    idempotent: true,
    success: {
      status: 201,
      description: "The upload session.",
      schema: responses.uploadSession,
      component: "UploadSession",
    },
  },
  {
    method: "POST",
    path: "/v1/uploads/{id}/parts",
    endpoint: uploads.signParts,
    operationId: "signUploadParts",
    tag: "Uploads",
    summary: "Get upload URLs for parts",
    description:
      "Presigned URLs for the parts still to upload, each bound to its exact size, plus the parts storage already has. Call it again to resume after a dropped connection.",
    pathParams: VIDEO_ID,
    body: signPartsSchema,
    success: {
      status: 200,
      description: "Part URLs and received parts.",
      schema: responses.signedParts,
      component: "SignedParts",
    },
  },
  {
    method: "POST",
    path: "/v1/uploads/{id}/complete",
    endpoint: uploads.completeUpload,
    operationId: "completeUpload",
    tag: "Uploads",
    summary: "Finish an upload",
    description:
      "Assembles the parts, checks the file really is a video (magic bytes), and queues it for transcoding. Calling it again returns the already-queued video. A file that was rejected answers 409.",
    pathParams: VIDEO_ID,
    body: completeUploadSchema,
    success: {
      status: 200,
      description: "The queued video.",
      schema: responses.videoResponse,
      component: "VideoResponse",
    },
  },
  {
    method: "DELETE",
    path: "/v1/uploads/{id}",
    endpoint: uploads.abortUpload,
    operationId: "abortUpload",
    tag: "Uploads",
    summary: "Cancel an upload",
    description: "Cancels an upload in progress and frees its stored parts.",
    pathParams: VIDEO_ID,
    success: {
      status: 200,
      description: "The cancelled video.",
      schema: responses.videoResponse,
      component: "VideoResponse",
    },
  },
  {
    method: "GET",
    path: "/v1/videos",
    endpoint: videos.listProjectVideos,
    operationId: "listVideos",
    tag: "Videos",
    summary: "List videos",
    description: "The project's videos, newest first, at every stage. Deleted videos are left out.",
    query: videos.listQuerySchema,
    success: {
      status: 200,
      description: "A page of videos.",
      schema: responses.videoList,
      component: "VideoList",
    },
  },
  {
    method: "GET",
    path: "/v1/videos/{id}",
    endpoint: videos.getProjectVideo,
    operationId: "getVideo",
    tag: "Videos",
    summary: "Get a video",
    description: "One video with its status and, once it is ready, its playback URLs.",
    pathParams: VIDEO_ID,
    success: {
      status: 200,
      description: "The video.",
      schema: responses.videoResponse,
      component: "VideoResponse",
    },
  },
  {
    method: "DELETE",
    path: "/v1/videos/{id}",
    endpoint: videos.deleteProjectVideo,
    operationId: "deleteVideo",
    tag: "Videos",
    summary: "Delete a video",
    description:
      "Deletes a video at any stage: it leaves feeds at once, a queued job is cancelled, `video.deleted` is sent to webhooks, and the worker removes its files shortly after. Deleting it again answers 404.",
    pathParams: VIDEO_ID,
    success: {
      status: 200,
      description: "Deleted.",
      schema: responses.deletedVideo,
      component: "DeletedVideo",
    },
  },
  {
    method: "GET",
    path: "/v1/project",
    endpoint: videos.getCurrentProject,
    operationId: "getProject",
    tag: "Project",
    summary: "Get the key's project",
    description:
      "The project the API key belongs to. With a secret key it also lists the allowed browser origins.",
    success: {
      status: 200,
      description: "The project.",
      schema: responses.project,
      component: "Project",
    },
  },
  {
    method: "GET",
    path: "/v1/health",
    operationId: "getHealth",
    tag: "Health",
    summary: "Health check",
    description: "Liveness and database reachability. No credentials; limited per address.",
    success: { status: 200, description: "Up.", schema: responses.health, component: "Health" },
  },
];

const SCHEMES: Record<Credential, { name: string; description: string }> = {
  secret: {
    name: "secretKey",
    description: "A secret key (`rp_sk_…`). Server-side only: it can manage every video.",
  },
  publishable: {
    name: "publishableKey",
    description:
      "A publishable key (`rp_pk_…`). Safe in a browser, and only accepted from the project's allowed origins.",
  },
  upload_token: {
    name: "uploadToken",
    description: "The upload token from `POST /v1/uploads`. Works only for that one video.",
  },
};

type JsonSchema = Record<string, unknown>;

/** Drops what helps validation but not readers: regexes behind a format, ±2^53 integer bounds. */
function tidy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(tidy);
  if (!value || typeof value !== "object") return value;
  const out: JsonSchema = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema" || key === "$id") continue;
    if (key === "pattern" && "format" in value) continue;
    if (
      (key === "minimum" || key === "maximum") &&
      Math.abs(Number(child)) === Number.MAX_SAFE_INTEGER
    )
      continue;
    out[key] = tidy(child);
  }
  return out;
}

const inputSchema = (schema: z.ZodType): JsonSchema =>
  tidy(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })) as JsonSchema;

function errorResponse(description: string) {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

function operationObject(op: Operation): JsonSchema {
  const options = op.endpoint?.options;
  const parameters: JsonSchema[] = Object.entries(op.pathParams ?? {}).map(
    ([name, description]) => ({
      name,
      in: "path",
      required: true,
      description,
      schema: { type: "string" },
    }),
  );
  if (op.query) {
    const query = inputSchema(op.query) as { properties?: Record<string, JsonSchema> };
    for (const [name, schema] of Object.entries(query.properties ?? {})) {
      parameters.push({ name, in: "query", required: false, schema });
    }
  }
  if (op.idempotent) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: false,
      description:
        "Makes retries safe: the same key and body within 24 hours replay the first response (marked `Idempotent-Replayed: true`); the same key with another body is a 409.",
      schema: { type: "string", maxLength: 255 },
    });
  }

  const responsesObject: Record<string, unknown> = {
    [op.success.status]: {
      description: op.success.description,
      content: {
        "application/json": { schema: { $ref: `#/components/schemas/${op.success.component}` } },
      },
    },
  };
  if (op.body || op.query)
    responsesObject["400"] = errorResponse("The request is invalid; `details` lists each problem.");
  if (options) {
    responsesObject["401"] = errorResponse("Missing or invalid credentials.");
    responsesObject["403"] = errorResponse(
      "This kind of credential may not call this, or the origin is not allowed.",
    );
  }
  if (op.pathParams) responsesObject["404"] = errorResponse("Not found (or in another project).");
  if (op.idempotent || op.operationId === "completeUpload" || op.operationId === "abortUpload")
    responsesObject["409"] = errorResponse("Conflicts with the current state.");
  responsesObject["429"] = errorResponse("Rate limited; wait for `Retry-After` seconds.");

  return {
    operationId: op.operationId,
    tags: [op.tag],
    summary: op.summary,
    description: op.description,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(op.body
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: inputSchema(op.body) } },
          },
        }
      : {}),
    responses: responsesObject,
    security: options
      ? options.allow.flatMap((credential) => [
          { [SCHEMES[credential].name]: [] },
          ...(options.allowQueryKey && credential === "publishable"
            ? [{ publishableKeyQuery: [] }]
            : []),
        ])
      : [],
    ...(options
      ? {
          "x-rate-limit": {
            limit: options.rateLimit.limit,
            windowSeconds: options.rateLimit.windowSeconds,
            per: options.rateLimit.by === "client" ? "client address" : "credential",
          },
        }
      : {}),
  };
}

function componentSchemas(): Record<string, unknown> {
  const registry = z.registry<{ id: string }>();
  registry.add(responses.errorResponse, { id: "Error" });
  registry.add(responses.video, { id: "Video" });
  registry.add(responses.feedItem, { id: "FeedItem" });
  for (const op of OPERATIONS) {
    if (!registry.has(op.success.schema))
      registry.add(op.success.schema, { id: op.success.component });
  }
  const { schemas } = z.toJSONSchema(registry, { uri: (id) => `#/components/schemas/${id}` });
  return tidy(schemas) as Record<string, unknown>;
}

/** The OpenAPI 3.1 document for the public API. */
export function buildOpenApi(): JsonSchema {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    paths[op.path] ??= {};
    paths[op.path] = { ...paths[op.path], [op.method.toLowerCase()]: operationObject(op) };
  }
  const securitySchemes: Record<string, unknown> = {
    publishableKeyQuery: {
      type: "apiKey",
      in: "query",
      name: "key",
      description: "The publishable key as `?key=`, for requests sent as a page unloads.",
    },
  };
  for (const scheme of Object.values(SCHEMES)) {
    securitySchemes[scheme.name] = {
      type: "http",
      scheme: "bearer",
      description: scheme.description,
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Reelplane API",
      version: "1.0.0",
      description:
        "Upload short videos, have them transcoded to an HLS ladder, and serve them as feeds. " +
        `Every response is JSON. Errors look like \`{ "error": { "code", "message", "details"? } }\`. ` +
        `Every endpoint is rate limited (\`x-rate-limit\` below, with \`RateLimit-*\` headers on each response), ` +
        `and each client address also gets ${CLIENT_RULE.limit} requests per ${CLIENT_RULE.windowSeconds} s across the whole API before its credentials are checked.`,
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: "/", description: "This deployment" }],
    tags: [
      { name: "Feeds", description: "What the player calls, from the browser." },
      { name: "Uploads", description: "Direct, resumable uploads to storage." },
      { name: "Videos", description: "Managing a project's videos (secret key)." },
      { name: "Project", description: "The API key's project." },
      { name: "Health", description: "Monitoring." },
    ],
    paths,
    components: { schemas: componentSchemas(), securitySchemes },
  };
}
