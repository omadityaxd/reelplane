import { withTenant } from "@reelplane/db";
import { MemoryObjectStorage } from "@reelplane/storage";
import { describe, expect, it } from "vitest";
import type { AppDeps } from "@/lib/server/deps.ts";
import { bind } from "@/lib/server/endpoint.ts";
import * as feeds from "@/lib/server/endpoints/feeds.ts";
import {
  API,
  apiRequest,
  body,
  newProject,
  ORIGIN,
  PEPPER,
  readyVideo,
  TEST_LIMITS,
  testPool,
} from "./harness.ts";

const pool = testPool();
const deps: AppDeps = {
  pool,
  pepper: PEPPER,
  storage: new MemoryObjectStorage(),
  limits: TEST_LIMITS,
};
const d = () => deps;
const routes = {
  feed: bind(feeds.getFeedPage, d),
  events: bind(feeds.ingestPlaybackEvents, d),
  like: bind(feeds.likeVideo, d),
  unlike: bind(feeds.unlikeVideo, d),
};
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

interface FeedBody {
  data: {
    id: string;
    likesCount: number;
    score?: { value: number; likes: number };
    playback: { hlsUrl: string };
  }[];
  nextCursor: string | null;
}

async function getFeed(key: string, feed: string, query = "", origin = ORIGIN): Promise<FeedBody> {
  const response = await routes.feed(
    apiRequest(`/v1/feeds/${encodeURIComponent(feed)}${query}`, {
      method: "GET",
      credential: key,
      headers: { origin },
    }),
    ctx({ feed: encodeURIComponent(feed) }),
  );
  expect(response.status).toBe(200);
  return body<FeedBody>(response);
}

describe("feeds", () => {
  it("serves the latest ready videos newest first, paginated without duplicates", async () => {
    const { project, publishableKey } = await newProject(pool);
    const ids = [];
    for (let hours = 0; hours < 5; hours += 1)
      ids.push(await readyVideo(pool, project.id, { hoursAgo: hours }));

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
      const page = await getFeed(publishableKey.key, "latest", query);
      seen.push(...page.data.map((video) => video.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(ids); // ids were created newest (0 h) to oldest (4 h)
  });

  it("never shows another project's videos", async () => {
    const a = await newProject(pool);
    const b = await newProject(pool);
    await readyVideo(pool, b.project.id);
    expect((await getFeed(a.publishableKey.key, "latest")).data).toEqual([]);
  });

  it("filters a creator feed", async () => {
    const { project, publishableKey } = await newProject(pool);
    const mine = await readyVideo(pool, project.id, { creatorId: "alice" });
    await readyVideo(pool, project.id, { creatorId: "bob" });
    expect((await getFeed(publishableKey.key, "creator:alice")).data.map((v) => v.id)).toEqual([
      mine,
    ]);
  });

  it("ranks trending by engagement and completion with time decay, and explains the score", async () => {
    const { project, publishableKey } = await newProject(pool);
    const quiet = await readyVideo(pool, project.id, { hoursAgo: 1 });
    const loved = await readyVideo(pool, project.id, {
      hoursAgo: 1,
      likes: 10,
      views: 20,
      completions: 18,
    });
    const oldHit = await readyVideo(pool, project.id, {
      hoursAgo: 24 * 7,
      likes: 10,
      views: 20,
      completions: 18,
    });

    const page = await getFeed(publishableKey.key, "trending", "?explain=1");
    expect(page.data.map((v) => v.id)).toEqual([loved, quiet, oldHit]);
    expect(page.data[0]?.score).toMatchObject({ likes: 10 });
    expect(page.data[0]?.score?.value).toBeGreaterThan(page.data[1]?.score?.value ?? Infinity);
  });

  it("rejects unknown feeds and bad cursors", async () => {
    const { publishableKey } = await newProject(pool);
    const unknown = await routes.feed(
      apiRequest("/v1/feeds/random", { method: "GET", credential: publishableKey.key }),
      ctx({ feed: "random" }),
    );
    const badCursor = await routes.feed(
      apiRequest("/v1/feeds/trending?cursor=nope", {
        method: "GET",
        credential: publishableKey.key,
      }),
      ctx({ feed: "trending" }),
    );
    expect([unknown.status, badCursor.status]).toEqual([404, 400]);
  });

  it("caches hot pages briefly", async () => {
    const { project, publishableKey } = await newProject(pool);
    await readyVideo(pool, project.id);
    const call = () =>
      routes.feed(
        apiRequest("/v1/feeds/latest", { method: "GET", credential: publishableKey.key }),
        ctx({ feed: "latest" }),
      );
    expect((await call()).headers.get("x-cache")).toBe("miss");
    expect((await call()).headers.get("x-cache")).toBe("hit");
  });
});

describe("playback events", () => {
  const send = (credential: string | undefined, payload: unknown, path = "/v1/playback-events") =>
    routes.events(apiRequest(path, { credential, body: payload, headers: { origin: ORIGIN } }));

  it("stores metrics and folds watches into view and completion counts", async () => {
    const { project, publishableKey } = await newProject(pool);
    const video = await readyVideo(pool, project.id);
    const events = [
      { videoId: video, sessionId: "s1", type: "ttff", valueMs: 420, data: { preloaded: true } },
      { videoId: video, sessionId: "s1", type: "watch", valueMs: 5000, data: { completion: 1 } },
      { videoId: video, sessionId: "s2", type: "watch", valueMs: 1000, data: { completion: 0.2 } },
    ];
    const response = await send(publishableKey.key, { events });
    expect(response.status).toBe(202);
    expect(await body(response)).toMatchObject({ data: { accepted: 3 } });

    const counts = await withTenant(
      pool,
      { projectId: project.id },
      async (client) =>
        (
          await client.query(
            "select views_count, completions_count from reelplane.videos where id = $1",
            [video],
          )
        ).rows[0],
    );
    expect(counts).toEqual({ views_count: 2, completions_count: 1 });
  });

  it("drops events for other projects' videos", async () => {
    const a = await newProject(pool);
    const b = await newProject(pool);
    const theirs = await readyVideo(pool, b.project.id);
    const response = await send(a.publishableKey.key, {
      events: [{ videoId: theirs, sessionId: "s", type: "watch", data: { completion: 1 } }],
    });
    expect(await body(response)).toMatchObject({ data: { accepted: 0 } });
  });

  it("accepts a publishable key in the URL (unload beacons) but never a secret key", async () => {
    const { project, publishableKey, secretKey } = await newProject(pool);
    const video = await readyVideo(pool, project.id);
    const payload = { events: [{ videoId: video, sessionId: "s", type: "ttff", valueMs: 300 }] };
    expect(
      (await send(undefined, payload, `/v1/playback-events?key=${publishableKey.key}`)).status,
    ).toBe(202);
    expect(
      (await send(undefined, payload, `/v1/playback-events?key=${secretKey.key}`)).status,
    ).toBe(403);
  });

  it("validates the batch", async () => {
    const { publishableKey } = await newProject(pool);
    const response = await send(publishableKey.key, {
      events: [{ videoId: "nope", sessionId: "s", type: "teleport" }],
    });
    expect(response.status).toBe(400);
  });
});

describe("likes", () => {
  const like = (key: string, id: string, liked: boolean, viewerId = "viewer-1") =>
    (liked ? routes.like : routes.unlike)(
      apiRequest(`/v1/videos/${id}/likes`, {
        method: liked ? "POST" : "DELETE",
        credential: key,
        body: { viewerId },
      }),
      ctx({ id }),
    );

  it("is idempotent per viewer and keeps the count in step", async () => {
    const { project, publishableKey } = await newProject(pool);
    const video = await readyVideo(pool, project.id);
    await like(publishableKey.key, video, true);
    await like(publishableKey.key, video, true);
    const second = await like(publishableKey.key, video, true, "viewer-2");
    expect(await body(second)).toMatchObject({ data: { likesCount: 2 } });
    const unliked = await like(publishableKey.key, video, false);
    expect(await body(unliked)).toMatchObject({ data: { likesCount: 1, liked: false } });
  });

  it("404s for unknown videos", async () => {
    const { publishableKey } = await newProject(pool);
    expect(
      (await like(publishableKey.key, "00000000-0000-4000-8000-000000000000", true)).status,
    ).toBe(404);
  });
});

void API;
