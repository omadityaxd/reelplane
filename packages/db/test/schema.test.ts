import { describe, expect, inject, it } from "vitest";
import { createPool, withTenant, withWorker } from "../src/index.ts";
import { migrate } from "../src/migrate.ts";
import { insertVideo, newProject, useTestPool } from "./helpers.ts";

const pool = useTestPool();

async function setStatus(projectId: string, videoId: string, status: string): Promise<void> {
  await withTenant(pool, { projectId }, (client) =>
    client.query("update reelplane.videos set status = $2 where id = $1", [videoId, status]),
  );
}

async function events(projectId: string, videoId: string) {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<{
      type: string;
      from_status: string | null;
      to_status: string | null;
    }>(
      "select type, from_status, to_status from reelplane.video_events where video_id = $1 order by id",
      [videoId],
    );
    return rows;
  });
}

describe("migrations", () => {
  it("are idempotent: a second run applies nothing", async () => {
    const second = createPool(inject("databaseUrl"), { max: 1 });
    try {
      const result = await migrate(second);
      expect(result.applied).toEqual([]);
      expect(result.skipped).toContain("0001_init");
    } finally {
      await second.end();
    }
  });
});

describe("video status audit trail", () => {
  it("records creation and every transition with from/to status", async () => {
    const { project } = await newProject(pool);
    const videoId = await insertVideo(pool, project.id);
    await setStatus(project.id, videoId, "queued");
    await setStatus(project.id, videoId, "processing");
    await setStatus(project.id, videoId, "ready");

    expect(await events(project.id, videoId)).toEqual([
      { type: "video.created", from_status: null, to_status: "uploading" },
      { type: "video.queued", from_status: "uploading", to_status: "queued" },
      { type: "video.processing", from_status: "queued", to_status: "processing" },
      { type: "video.ready", from_status: "processing", to_status: "ready" },
    ]);
  });

  it.each([
    ["uploading", "ready"],
    ["uploading", "processing"],
    ["ready", "queued"],
    ["deleted", "ready"],
  ])("rejects the illegal transition %s -> %s", async (from, to) => {
    const { project } = await newProject(pool);
    const videoId = await insertVideo(pool, project.id, from);
    await expect(setStatus(project.id, videoId, to)).rejects.toThrow(
      /illegal video status transition/,
    );
  });

  it("does not let the API role edit or delete the audit trail", async () => {
    const { project } = await newProject(pool);
    await insertVideo(pool, project.id);
    await expect(
      withTenant(pool, { projectId: project.id }, (client) =>
        client.query("delete from reelplane.video_events"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("jobs", () => {
  async function enqueue(projectId: string, videoId: string) {
    return withTenant(pool, { projectId }, (client) =>
      client.query("insert into reelplane.jobs (video_id, project_id) values ($1, $2)", [
        videoId,
        projectId,
      ]),
    );
  }

  it("allows at most one active transcode job per video", async () => {
    const { project } = await newProject(pool);
    const videoId = await insertVideo(pool, project.id);
    await enqueue(project.id, videoId);
    await expect(enqueue(project.id, videoId)).rejects.toThrow(/jobs_one_active_per_video/);
  });

  it("allows a new job once the previous one is finished", async () => {
    const { project } = await newProject(pool);
    const videoId = await insertVideo(pool, project.id);
    await enqueue(project.id, videoId);
    await withWorker(pool, (client) =>
      client.query(
        "update reelplane.jobs set state = 'dead', last_error = 'boom' where video_id = $1",
        [videoId],
      ),
    );
    await expect(enqueue(project.id, videoId)).resolves.toBeDefined();
  });

  it("requires a lease exactly when a job is running", async () => {
    const { project } = await newProject(pool);
    const videoId = await insertVideo(pool, project.id);
    await enqueue(project.id, videoId);
    await expect(
      withWorker(pool, (client) =>
        client.query("update reelplane.jobs set state = 'running' where video_id = $1", [videoId]),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("records job state changes in the video timeline", async () => {
    const { project } = await newProject(pool);
    const videoId = await insertVideo(pool, project.id);
    await enqueue(project.id, videoId);
    await withWorker(pool, (client) =>
      client.query(
        `update reelplane.jobs set state = 'running', attempts = 1, lease_owner = 'w1',
                lease_expires_at = now() + interval '2 minutes' where video_id = $1`,
        [videoId],
      ),
    );
    const types = (await events(project.id, videoId)).map((event) => event.type);
    expect(types).toEqual(["video.created", "job.queued", "job.running"]);
  });
});
