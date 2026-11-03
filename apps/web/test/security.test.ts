import { type Pool, withTenant } from "@reelplane/db";
import { MemoryObjectStorage } from "@reelplane/storage";
import { describe, expect, it } from "vitest";
import type { AppDeps } from "@/lib/server/deps.ts";
import { bind } from "@/lib/server/endpoint.ts";
import * as feeds from "@/lib/server/endpoints/feeds.ts";
import * as uploads from "@/lib/server/endpoints/uploads.ts";
import * as videos from "@/lib/server/endpoints/videos.ts";
import {
  apiRequest,
  body,
  newProject,
  ORIGIN,
  PEPPER,
  readyVideo,
  TEST_LIMITS,
  testPool,
} from "./harness.ts";

/**
 * Cross-project access, endpoint by endpoint: project B's credentials (secret key, publishable
 * key, upload token) against project A's videos and uploads. Every call must be refused (404,
 * or 401/403 for a credential that isn't valid there) and A's data must be unchanged. A new
 * endpoint taking an id belongs in this table.
 */
const pool = testPool();
const deps: AppDeps = {
  pool,
  pepper: PEPPER,
  storage: new MemoryObjectStorage(),
  limits: TEST_LIMITS,
};
const d = () => deps;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const a = await newProject(pool);
const b = await newProject(pool);
const aReady = await readyVideo(pool, a.project.id);
const createUpload = bind(uploads.createUpload, d);
const session = async (secret: string) =>
  (
    await body<{ data: { upload: { videoId: string; token: string } } }>(
      await createUpload(
        apiRequest("/v1/uploads", {
          credential: secret,
          body: { contentType: "video/mp4", sizeBytes: 1000 },
        }),
      ),
    )
  ).data.upload;
const aUpload = await session(a.secretKey.key);
const bUpload = await session(b.secretKey.key);

/** A's rows that any of these calls could change. */
async function snapshot(db: Pool, projectId: string) {
  return withTenant(db, { projectId }, async (client) => {
    const { rows } = await client.query(
      `select (select json_agg(json_build_object('id', id, 'status', status, 'likes', likes_count) order by id)
                 from reelplane.videos) as videos,
              (select count(*)::int from reelplane.playback_events) as events,
              (select count(*)::int from reelplane.likes) as likes,
              (select count(*)::int from reelplane.video_reports) as reports`,
    );
    return rows[0];
  });
}

interface Case {
  name: string;
  call: () => Promise<Response>;
}

const browser = { origin: ORIGIN };
const cases: Case[] = [
  {
    name: "GET /v1/videos/:id (B secret)",
    call: () =>
      bind(videos.getProjectVideo, d)(
        apiRequest(`/v1/videos/${aReady}`, { method: "GET", credential: b.secretKey.key }),
        ctx(aReady),
      ),
  },
  {
    name: "DELETE /v1/videos/:id (B secret)",
    call: () =>
      bind(videos.deleteProjectVideo, d)(
        apiRequest(`/v1/videos/${aReady}`, { method: "DELETE", credential: b.secretKey.key }),
        ctx(aReady),
      ),
  },
  {
    name: "POST /v1/videos/:id/likes (B publishable)",
    call: () =>
      bind(feeds.likeVideo, d)(
        apiRequest(`/v1/videos/${aReady}/likes`, {
          credential: b.publishableKey.key,
          headers: browser,
          body: { viewerId: "v" },
        }),
        ctx(aReady),
      ),
  },
  {
    name: "DELETE /v1/videos/:id/likes (B secret)",
    call: () =>
      bind(feeds.unlikeVideo, d)(
        apiRequest(`/v1/videos/${aReady}/likes`, {
          method: "DELETE",
          credential: b.secretKey.key,
          body: { viewerId: "v" },
        }),
        ctx(aReady),
      ),
  },
  {
    name: "POST /v1/videos/:id/reports (B publishable)",
    call: () =>
      bind(feeds.reportFeedVideo, d)(
        apiRequest(`/v1/videos/${aReady}/reports`, {
          credential: b.publishableKey.key,
          headers: browser,
          body: { reason: "spam" },
        }),
        ctx(aReady),
      ),
  },
  {
    name: "POST /v1/uploads/:id/parts (B secret)",
    call: () =>
      bind(uploads.signParts, d)(
        apiRequest(`/v1/uploads/${aUpload.videoId}/parts`, {
          credential: b.secretKey.key,
          body: {},
        }),
        ctx(aUpload.videoId),
      ),
  },
  {
    name: "POST /v1/uploads/:id/parts (B's upload token on A's upload)",
    call: () =>
      bind(uploads.signParts, d)(
        apiRequest(`/v1/uploads/${aUpload.videoId}/parts`, { credential: bUpload.token, body: {} }),
        ctx(aUpload.videoId),
      ),
  },
  {
    name: "POST /v1/uploads/:id/complete (B secret)",
    call: () =>
      bind(uploads.completeUpload, d)(
        apiRequest(`/v1/uploads/${aUpload.videoId}/complete`, {
          credential: b.secretKey.key,
          body: {},
        }),
        ctx(aUpload.videoId),
      ),
  },
  {
    name: "DELETE /v1/uploads/:id (B's upload token on A's upload)",
    call: () =>
      bind(uploads.abortUpload, d)(
        apiRequest(`/v1/uploads/${aUpload.videoId}`, {
          method: "DELETE",
          credential: bUpload.token,
        }),
        ctx(aUpload.videoId),
      ),
  },
];

describe("cross-project access is refused", () => {
  it.each(cases)("$name", async ({ call }) => {
    const before = await snapshot(pool, a.project.id);
    const response = await call();
    expect([401, 403, 404]).toContain(response.status);
    expect(await snapshot(pool, a.project.id)).toEqual(before);
  });

  it("POST /v1/playback-events: B can't write events for A's video", async () => {
    const before = await snapshot(pool, a.project.id);
    const response = await bind(
      feeds.ingestPlaybackEvents,
      d,
    )(
      apiRequest("/v1/playback-events", {
        credential: b.publishableKey.key,
        headers: browser,
        body: { events: [{ videoId: aReady, sessionId: "s", type: "ttff", valueMs: 10 }] },
      }),
    );
    // The batch is accepted (events for unknown videos are dropped, not errors) but nothing
    // lands in A's project.
    expect(response.status).toBe(202);
    expect(((await response.json()) as { data: { accepted: number } }).data.accepted).toBe(0);
    expect(await snapshot(pool, a.project.id)).toEqual(before);
  });

  it("GET /v1/feeds/latest and /v1/videos: B never sees A's videos", async () => {
    const feed = await bind(feeds.getFeedPage, d)(
      apiRequest("/v1/feeds/latest", {
        method: "GET",
        credential: b.publishableKey.key,
        headers: browser,
      }),
      { params: Promise.resolve({ feed: "latest" }) },
    );
    const list = await bind(
      videos.listProjectVideos,
      d,
    )(apiRequest("/v1/videos", { method: "GET", credential: b.secretKey.key }));
    const ids = [
      ...(await body<{ data: { id: string }[] }>(feed)).data,
      ...(await body<{ data: { id: string }[] }>(list)).data,
    ].map((v) => v.id);
    expect(ids).not.toContain(aReady);
    expect(ids).not.toContain(aUpload.videoId);
  });

  it("A's credentials still work on the same calls (the table above is testing access, not typos)", async () => {
    const get = await bind(videos.getProjectVideo, d)(
      apiRequest(`/v1/videos/${aReady}`, { method: "GET", credential: a.secretKey.key }),
      ctx(aReady),
    );
    const sign = await bind(uploads.signParts, d)(
      apiRequest(`/v1/uploads/${aUpload.videoId}/parts`, { credential: aUpload.token, body: {} }),
      ctx(aUpload.videoId),
    );
    expect([get.status, sign.status]).toEqual([200, 200]);
  });
});

describe("credentials used where they don't belong", () => {
  it("a publishable key from an origin the project doesn't allow is refused", async () => {
    const response = await bind(feeds.getFeedPage, d)(
      apiRequest("/v1/feeds/latest", {
        method: "GET",
        credential: a.publishableKey.key,
        headers: { origin: "https://evil.example" },
      }),
      { params: Promise.resolve({ feed: "latest" }) },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("a secret key sent from a browser page is refused (it must never be in a page)", async () => {
    const response = await bind(
      videos.listProjectVideos,
      d,
    )(apiRequest("/v1/videos", { method: "GET", credential: a.secretKey.key, headers: browser }));
    expect(response.status).toBe(403);
  });

  it("a publishable key can't use server-only endpoints", async () => {
    for (const call of [
      () =>
        bind(
          videos.listProjectVideos,
          d,
        )(apiRequest("/v1/videos", { method: "GET", credential: a.publishableKey.key })),
      () =>
        bind(videos.deleteProjectVideo, d)(
          apiRequest(`/v1/videos/${aReady}`, {
            method: "DELETE",
            credential: a.publishableKey.key,
          }),
          ctx(aReady),
        ),
      () =>
        createUpload(
          apiRequest("/v1/uploads", {
            credential: a.publishableKey.key,
            body: { contentType: "video/mp4", sizeBytes: 1000 },
          }),
        ),
    ]) {
      expect((await call()).status).toBe(403);
    }
  });
});
