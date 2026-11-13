import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { uploadVideo } from "@reelplane/sdk-core";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { AppDeps } from "@/lib/server/deps.ts";
import { bind } from "@/lib/server/endpoint.ts";
import * as feeds from "@/lib/server/endpoints/feeds.ts";
import * as uploads from "@/lib/server/endpoints/uploads.ts";
import * as videos from "@/lib/server/endpoints/videos.ts";
import * as responses from "@/lib/server/openapi/responses.ts";
import { buildOpenApi, OPERATIONS } from "@/lib/server/openapi/spec.ts";
import {
  API,
  apiRequest,
  bindApi,
  fakeMp4,
  newProject,
  ORIGIN,
  PEPPER,
  readyVideo,
  storagesUnderTest,
  TEST_LIMITS,
  testPool,
  toBlob,
} from "./harness.ts";

const WEB = join(import.meta.dirname, "..");
const ENDPOINT_MODULES: Record<string, Record<string, unknown>> = { feeds, uploads, videos };

/** Every `route.ts` under app/v1: its URL path and, per HTTP method, the endpoint it binds. */
function routeFiles(): { path: string; method: string; endpoint: unknown; file: string }[] {
  const found: { path: string; method: string; endpoint: unknown; file: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts") {
        const source = readFileSync(full, "utf8");
        const path = `/${relative(join(WEB, "app"), dir).split(sep).join("/")}`.replace(
          /\[(\w+)\]/g,
          "{$1}",
        );
        const imports = new Map<string, string>();
        for (const [, names = "", module = ""] of source.matchAll(
          /import \{([^}]+)\} from "@\/lib\/server\/endpoints\/(\w+)\.ts"/g,
        )) {
          for (const imported of names.split(",")) imports.set(imported.trim(), module);
        }
        for (const [, method = "", name = ""] of source.matchAll(
          /export const (GET|POST|DELETE|PUT|PATCH) = bind\((\w+),/g,
        )) {
          const module = ENDPOINT_MODULES[imports.get(name) ?? ""];
          found.push({ path, method, endpoint: module?.[name], file: full });
        }
        for (const [, method = ""] of source.matchAll(
          /export async function (GET|POST|DELETE|PUT|PATCH)\(/g,
        )) {
          found.push({ path, method, endpoint: undefined, file: full });
        }
      }
    }
  };
  walk(join(WEB, "app", "v1"));
  return found;
}

describe("OpenAPI document", () => {
  it("lists exactly the routes in app/v1, each with the endpoint its route binds", () => {
    const routes = routeFiles();
    expect(routes.length).toBeGreaterThan(10);
    const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
    expect(OPERATIONS.map(key).sort()).toEqual(routes.map(key).sort());
    for (const route of routes) {
      const op = OPERATIONS.find((o) => key(o) === key(route));
      expect(op?.endpoint, `${key(route)} (${route.file})`).toBe(route.endpoint);
    }
  });

  it("is the committed docs/openapi.json (run `pnpm --filter @reelplane/web openapi`)", () => {
    const committed = readFileSync(join(WEB, "..", "..", "docs", "openapi.json"), "utf8");
    expect(JSON.parse(committed)).toEqual(buildOpenApi());
  });

  it("takes auth and rate limits from the endpoints themselves", () => {
    const doc = buildOpenApi() as {
      paths: Record<
        string,
        Record<string, { security: object[]; "x-rate-limit"?: { limit: number } }>
      >;
    };
    const upload = doc.paths["/v1/uploads"]?.post;
    expect(upload?.security).toEqual([{ secretKey: [] }]);
    expect(upload?.["x-rate-limit"]?.limit).toBe(uploads.createUpload.options.rateLimit.limit);
    expect(doc.paths["/v1/playback-events"]?.post?.security).toContainEqual({
      publishableKeyQuery: [],
    });
    expect(doc.paths["/v1/uploads/{id}/parts"]?.post?.security).toContainEqual({ uploadToken: [] });
  });
});

describe("real responses match the documented schemas", () => {
  const pool = testPool();
  const [{ storage, transport }] = storagesUnderTest() as [
    ReturnType<typeof storagesUnderTest>[number],
  ];
  const deps: AppDeps = { pool, pepper: PEPPER, storage, limits: TEST_LIMITS };
  const api = bindApi(deps);
  const d = () => deps;
  const routeFor = (operationId: string) => {
    const endpoint = OPERATIONS.find((op) => op.operationId === operationId)?.endpoint;
    if (!endpoint) throw new Error(`no endpoint for ${operationId}`);
    return bind(endpoint, d);
  };

  /** Calls an operation and checks the status and body against the document. */
  async function call(
    operationId: string,
    path: string,
    options: Parameters<typeof apiRequest>[1] & { id?: string; feed?: string } = {},
  ): Promise<unknown> {
    const op = OPERATIONS.find((o) => o.operationId === operationId);
    if (!op) throw new Error(operationId);
    const params = {
      ...(options.id ? { id: options.id } : {}),
      ...(options.feed ? { feed: options.feed } : {}),
    };
    const response = await routeFor(operationId)(
      apiRequest(path, { method: op.method, ...options }),
      { params: Promise.resolve(params) },
    );
    const body = await response.json();
    expect(response.status, `${operationId}: ${JSON.stringify(body)}`).toBe(op.success.status);
    return (op.success.schema as z.ZodType).parse(body);
  }

  it("for every operation", async () => {
    const { secretKey, publishableKey, project } = await newProject(pool);
    const secret = { credential: secretKey.key };
    const browser = { credential: publishableKey.key, headers: { origin: ORIGIN } };
    const covered = new Set<string>();
    const check = async (id: string, path: string, options: Parameters<typeof call>[2] = {}) => {
      covered.add(id);
      return call(id, path, options);
    };

    // Uploads, end to end against in-memory storage.
    const bytes = fakeMp4(6 * 1024 * 1024);
    const created = (await check("createUpload", "/v1/uploads", {
      ...secret,
      body: { contentType: "video/mp4", sizeBytes: bytes.byteLength, title: "Spec" },
    })) as z.infer<typeof responses.uploadSession>;
    const { videoId, token } = created.data.upload;
    await check("signUploadParts", `/v1/uploads/${videoId}/parts`, {
      ...secret,
      body: {},
      id: videoId,
    });
    await uploadVideo({
      apiBaseUrl: API,
      file: toBlob(bytes),
      session: { videoId, token },
      fetch: api.fetch,
      transport,
      wait: async () => undefined,
    });
    await check("completeUpload", `/v1/uploads/${videoId}/complete`, {
      ...secret,
      body: {},
      id: videoId,
    });
    const other = (await call("createUpload", "/v1/uploads", {
      ...secret,
      body: { contentType: "video/webm", sizeBytes: 1000 },
    })) as z.infer<typeof responses.uploadSession>;
    const abortId = other.data.upload.videoId;
    await check("abortUpload", `/v1/uploads/${abortId}`, { ...secret, id: abortId });

    // Videos and the project.
    await check("listVideos", "/v1/videos?limit=5", secret);
    await check("getVideo", `/v1/videos/${videoId}`, { ...secret, id: videoId });
    await check("getProject", "/v1/project", secret);
    await check("getProject", "/v1/project", browser);

    // Feeds, with a ready video (as the worker leaves one).
    const ready = await readyVideo(pool, project.id, { likes: 2, views: 5 });
    const page = (await check("getFeed", "/v1/feeds/trending?explain=1", {
      ...browser,
      method: "GET",
      feed: "trending",
    })) as z.infer<typeof responses.feedPage>;
    expect(page.data[0]?.score).toBeDefined();
    await check("getFeed", "/v1/feeds/latest?limit=2", { ...browser, feed: "latest" });
    await check("likeVideo", `/v1/videos/${ready}/likes`, {
      ...browser,
      body: { viewerId: "v1" },
      id: ready,
    });
    await check("unlikeVideo", `/v1/videos/${ready}/likes`, {
      ...browser,
      body: { viewerId: "v1" },
      id: ready,
    });
    await check("reportVideo", `/v1/videos/${ready}/reports`, {
      ...browser,
      body: { reason: "spam" },
      id: ready,
    });
    await check("sendPlaybackEvents", "/v1/playback-events", {
      ...browser,
      body: { events: [{ videoId: ready, sessionId: "s1", type: "ttff", valueMs: 120 }] },
    });
    await check("deleteVideo", `/v1/videos/${ready}`, { ...secret, id: ready });

    // Every authenticated operation was exercised (health has no endpoint to bind).
    const authenticated = OPERATIONS.filter((op) => op.endpoint).map((op) => op.operationId);
    expect([...covered].sort()).toEqual([...new Set(authenticated)].sort());
  });

  it("errors use the documented error shape", async () => {
    const { secretKey } = await newProject(pool);
    const missing = await routeFor("getVideo")(
      apiRequest("/v1/videos/00000000-0000-4000-8000-000000000000", {
        method: "GET",
        credential: secretKey.key,
      }),
      { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }) },
    );
    expect(missing.status).toBe(404);
    responses.errorResponse.parse(await missing.json());

    const invalid = await routeFor("createUpload")(
      apiRequest("/v1/uploads", { credential: secretKey.key, body: { contentType: "image/png" } }),
      { params: Promise.resolve({}) },
    );
    expect(invalid.status).toBe(400);
    const body = responses.errorResponse.parse(await invalid.json());
    expect(body.error.details).toBeInstanceOf(Array);
  });
});
