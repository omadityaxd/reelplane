import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createWebhookEndpoint,
  dailyPlayback,
  deleteVideo,
  deleteWebhookEndpoint,
  getOwnedProject,
  getWebhookSecret,
  listJobs,
  listWebhookDeliveries,
  listWebhookEndpoints,
  MAX_WEBHOOK_ENDPOINTS,
  redeliverWebhook,
  sendTestWebhook,
  TooManyWebhookEndpointsError,
  updateWebhookEndpoint,
  videoTimeline,
  withTenant,
  withWorker,
} from "../src/index.ts";
import { insertVideo, newProject, useTestPool } from "./helpers.ts";

const pool = useTestPool();

async function setStatus(videoId: string, status: string): Promise<void> {
  await withWorker(pool, (client) =>
    client.query("update reelplane.videos set status = $2 where id = $1", [videoId, status]),
  );
}

async function walkToReady(videoId: string): Promise<void> {
  for (const status of ["queued", "processing", "ready"]) await setStatus(videoId, status);
}

describe("webhook outbox", () => {
  it("queues one delivery per subscribed, enabled endpoint when a video becomes ready", async () => {
    const { project } = await newProject(pool);
    const all = await createWebhookEndpoint(pool, project.id, {
      url: "https://a.example/hook",
      events: ["video.ready", "video.failed", "video.deleted"],
    });
    await createWebhookEndpoint(pool, project.id, {
      url: "https://b.example/hook",
      events: ["video.deleted"],
    });
    const disabled = await createWebhookEndpoint(pool, project.id, {
      url: "https://c.example/hook",
      events: ["video.ready"],
    });
    await updateWebhookEndpoint(pool, project.id, disabled.id, { enabled: false });

    const videoId = await insertVideo(pool, project.id);
    await walkToReady(videoId);

    const deliveries = await listWebhookDeliveries(pool, project.id);
    expect(deliveries.map((d) => [d.endpointId, d.eventType])).toEqual([[all.id, "video.ready"]]);
    const payload = deliveries[0]?.payload as {
      id: string;
      type: string;
      data: { video: { id: string; status: string } };
    };
    expect(payload.type).toBe("video.ready");
    expect(payload.id).toBe(deliveries[0]?.eventId);
    expect(payload.data.video).toMatchObject({ id: videoId, status: "ready" });
  });

  it("queues nothing for a status change that is rolled back", async () => {
    const { project } = await newProject(pool);
    await createWebhookEndpoint(pool, project.id, {
      url: "https://a.example/hook",
      events: ["video.failed"],
    });
    const videoId = await insertVideo(pool, project.id);
    await expect(
      withWorker(pool, async (client) => {
        await client.query("update reelplane.videos set status = 'failed' where id = $1", [
          videoId,
        ]);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await listWebhookDeliveries(pool, project.id)).toEqual([]);
  });

  it("gives every endpoint the same event id for one event", async () => {
    const { project } = await newProject(pool);
    for (const host of ["a", "b"]) {
      await createWebhookEndpoint(pool, project.id, {
        url: `https://${host}.example/hook`,
        events: ["video.deleted"],
      });
    }
    const videoId = await insertVideo(pool, project.id);
    await deleteVideo(pool, project.id, videoId);
    const deliveries = await listWebhookDeliveries(pool, project.id);
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map((d) => d.eventId)).size).toBe(1);
  });

  it("queues a test event and redelivers finished deliveries", async () => {
    const { project } = await newProject(pool);
    const endpoint = await createWebhookEndpoint(pool, project.id, {
      url: "https://a.example/hook",
      events: ["video.ready"],
    });
    expect(await sendTestWebhook(pool, project.id, endpoint.id)).toBe(true);
    const [test] = await listWebhookDeliveries(pool, project.id);
    expect(test?.eventType).toBe("webhook.test");
    // Still pending: nothing to redeliver yet.
    expect(await redeliverWebhook(pool, project.id, test?.id ?? "")).toBe(false);
    await withTenant(pool, { projectId: project.id }, (client) =>
      client.query(
        "update reelplane.webhook_deliveries set state = 'dead', attempts = 10 where id = $1",
        [test?.id],
      ),
    );
    expect(await redeliverWebhook(pool, project.id, test?.id ?? "")).toBe(true);
    const [again] = await listWebhookDeliveries(pool, project.id);
    expect(again).toMatchObject({ state: "pending", attempts: 0 });
  });

  it("caps endpoints per project, even when created concurrently", async () => {
    const { project } = await newProject(pool);
    const results = await Promise.allSettled(
      Array.from({ length: MAX_WEBHOOK_ENDPOINTS + 5 }, (_, i) =>
        createWebhookEndpoint(pool, project.id, {
          url: `https://a.example/${i}`,
          events: ["video.ready"],
        }),
      ),
    );
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(5);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(TooManyWebhookEndpointsError);
    expect(await listWebhookEndpoints(pool, project.id)).toHaveLength(MAX_WEBHOOK_ENDPOINTS);
  });

  it("rolls the signing secret", async () => {
    const { project } = await newProject(pool);
    const endpoint = await createWebhookEndpoint(pool, project.id, {
      url: "https://a.example/hook",
      events: ["video.ready"],
    });
    const before = await getWebhookSecret(pool, project.id, endpoint.id);
    expect(before).toMatch(/^whsec_[\w-]{43}$/);
    await updateWebhookEndpoint(pool, project.id, endpoint.id, { rollSecret: true });
    expect(await getWebhookSecret(pool, project.id, endpoint.id)).not.toBe(before);
  });

  it("a project cannot see, change or trigger another project's endpoints and deliveries", async () => {
    const { project: mine } = await newProject(pool);
    const { project: theirs } = await newProject(pool);
    const endpoint = await createWebhookEndpoint(pool, theirs.id, {
      url: "https://theirs.example/hook",
      events: ["video.ready"],
    });
    await sendTestWebhook(pool, theirs.id, endpoint.id);
    const [delivery] = await listWebhookDeliveries(pool, theirs.id);

    expect(await listWebhookEndpoints(pool, mine.id)).toEqual([]);
    expect(await listWebhookDeliveries(pool, mine.id)).toEqual([]);
    expect(await getWebhookSecret(pool, mine.id, endpoint.id)).toBeNull();
    expect(await sendTestWebhook(pool, mine.id, endpoint.id)).toBe(false);
    expect(await updateWebhookEndpoint(pool, mine.id, endpoint.id, { enabled: false })).toBe(false);
    expect(await redeliverWebhook(pool, mine.id, delivery?.id ?? "")).toBe(false);
    expect(await deleteWebhookEndpoint(pool, mine.id, endpoint.id)).toBe(false);
    expect(await listWebhookEndpoints(pool, theirs.id)).toHaveLength(1);
  });
});

describe("deleting a video", () => {
  it("marks it deleted, cancels its queued job and queues its storage for sweeping", async () => {
    const { project } = await newProject(pool);
    const videoId = await insertVideo(pool, project.id);
    await setStatus(videoId, "queued");
    await withTenant(pool, { projectId: project.id }, (client) =>
      client.query("insert into reelplane.jobs (video_id, project_id) values ($1, $2)", [
        videoId,
        project.id,
      ]),
    );

    expect(await deleteVideo(pool, project.id, videoId)).toBe("queued");
    expect(await deleteVideo(pool, project.id, videoId)).toBeNull(); // already deleted

    const [job] = await listJobs(pool, project.id, { videoId });
    expect(job?.state).toBe("cancelled");
    const timeline = await videoTimeline(pool, project.id, videoId);
    expect(timeline.map((e) => e.type)).toContain("video.deleted");
    const garbage = await withWorker(pool, async (client) => {
      const { rows } = await client.query<{ prefix: string }>(
        "select prefix from reelplane.storage_garbage where prefix like '%' || $1 || '/' order by prefix",
        [videoId],
      );
      return rows.map((r) => r.prefix);
    });
    expect(garbage).toEqual([
      `media/${project.id}/${videoId}/`,
      `originals/${project.id}/${videoId}/`,
    ]);
  });

  it("cannot delete another project's video", async () => {
    const { project: mine } = await newProject(pool);
    const { project: theirs } = await newProject(pool);
    const videoId = await insertVideo(pool, theirs.id);
    expect(await deleteVideo(pool, mine.id, videoId)).toBeNull();
    expect(await videoTimeline(pool, mine.id, videoId)).toEqual([]);
    const [created] = await videoTimeline(pool, theirs.id, videoId);
    expect(created?.toStatus).toBe("uploading");
  });
});

describe("dashboard access", () => {
  it("returns a project only to its owner", async () => {
    const { project } = await newProject(pool);
    expect((await getOwnedProject(pool, project.ownerId, project.id))?.id).toBe(project.id);
    expect(await getOwnedProject(pool, randomUUID(), project.id)).toBeNull();
    expect(await getOwnedProject(pool, project.ownerId, randomUUID())).toBeNull();
  });
});

describe("daily playback analytics", () => {
  it("returns every day of the window, with today's numbers", async () => {
    const { project } = await newProject(pool);
    const videoId = await insertVideo(pool, project.id);
    await withTenant(pool, { projectId: project.id }, (client) =>
      client.query(
        `insert into reelplane.playback_events (project_id, video_id, session_id, type, value_ms, data)
         values ($1, $2, 's', 'ttff', 100, '{}'), ($1, $2, 's', 'ttff', 300, '{}'),
                ($1, $2, 's', 'watch', 5000, '{"completion": 0.5}'),
                ($1, $2, 's', 'watch', 9000, '{"completion": 1.2}'),
                ($1, $2, 's', 'rebuffer', 400, '{}')`,
        [project.id, videoId],
      ),
    );
    const days = await dailyPlayback(pool, project.id, 7);
    expect(days).toHaveLength(7);
    expect(days.slice(0, 6).every((d) => d.views === 0 && d.ttffP50 === null)).toBe(true);
    expect(days[6]).toEqual({
      day: new Date().toISOString().slice(0, 10),
      views: 2,
      ttffP50: 200,
      ttffP95: 290,
      rebufferRate: 0.5,
      completionRate: 0.75,
    });
  });
});
