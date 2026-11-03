import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  getFeed,
  reportVideo,
  takeDemoUploadQuota,
  unhideVideo,
  withTenant,
  withWorker,
} from "../src/index.ts";
import { insertVideo, newProject, useTestPool } from "./helpers.ts";

const pool = useTestPool();

async function readyVideo(projectId: string): Promise<string> {
  const id = await insertVideo(pool, projectId);
  await withWorker(pool, async (client) => {
    for (const status of ["queued", "processing", "ready"]) {
      await client.query(
        "update reelplane.videos set status = $2, ready_at = now(), master_playlist_key = 'm' where id = $1",
        [id, status],
      );
    }
  });
  return id;
}

async function makeDemo(projectId: string): Promise<void> {
  // As the table owner: no code path makes a project a demo (the seed scripts set it).
  await pool.query("update reelplane.projects set is_demo = true where id = $1", [projectId]);
}

describe("reports", () => {
  it("hide a video from every feed after three different reporters", async () => {
    const { project } = await newProject(pool);
    const videoId = await readyVideo(project.id);
    const feedIds = async () =>
      (
        await getFeed(pool, { projectId: project.id, feed: { kind: "latest" }, limit: 10 })
      ).videos.map((v) => v.id);

    expect(await reportVideo(pool, project.id, videoId, "a", "spam")).toBe(true);
    expect(await reportVideo(pool, project.id, videoId, "a", "other")).toBe(true); // same reporter
    expect(await reportVideo(pool, project.id, videoId, "b", "spam")).toBe(true);
    expect(await feedIds()).toContain(videoId); // two distinct reporters: still shown
    await reportVideo(pool, project.id, videoId, "c", "nudity");
    expect(await feedIds()).not.toContain(videoId);
  });

  it("never auto-hide a showcase video, and an owner can show a hidden one again", async () => {
    const { project } = await newProject(pool);
    const showcase = await readyVideo(project.id);
    const regular = await readyVideo(project.id);
    await pool.query("update reelplane.videos set is_showcase = true where id = $1", [showcase]);
    for (const reporter of ["a", "b", "c"]) {
      await reportVideo(pool, project.id, showcase, reporter, "spam");
      await reportVideo(pool, project.id, regular, reporter, "spam");
    }
    const visible = async () =>
      (
        await getFeed(pool, { projectId: project.id, feed: { kind: "latest" }, limit: 10 })
      ).videos.map((v) => v.id);
    expect(await visible()).toEqual([showcase]);

    expect(await unhideVideo(pool, project.id, regular)).toBe(true);
    expect((await visible()).sort()).toEqual([showcase, regular].sort());
    expect(await unhideVideo(pool, project.id, regular)).toBe(false); // already visible
    // Its reports were cleared: one new report doesn't hide it again.
    await reportVideo(pool, project.id, regular, "a", "spam");
    expect(await visible()).toContain(regular);
  });

  it("cannot report another project's video", async () => {
    const { project: mine } = await newProject(pool);
    const { project: theirs } = await newProject(pool);
    const videoId = await readyVideo(theirs.id);
    expect(await reportVideo(pool, mine.id, videoId, "a", "spam")).toBe(false);
    const count = await withTenant(pool, { projectId: theirs.id }, async (client) => {
      const { rows } = await client.query<{ n: number }>(
        "select count(*)::int as n from reelplane.video_reports",
      );
      return rows[0]?.n;
    });
    expect(count).toBe(0);
  });
});

describe("demo upload quotas", () => {
  it("hold per user and for the whole demo, even under concurrent requests", async () => {
    const { project } = await newProject(pool);
    await makeDemo(project.id);
    const limits = { perUser: 2, perDemo: 3 };
    const alice = randomUUID();
    const bob = randomUUID();

    const aliceTries = await Promise.all(
      Array.from({ length: 5 }, () => takeDemoUploadQuota(pool, project.id, alice, limits)),
    );
    expect(aliceTries.filter((r) => r === "ok")).toHaveLength(2);
    expect(aliceTries.filter((r) => r === "user_limit")).toHaveLength(3);

    expect(await takeDemoUploadQuota(pool, project.id, bob, limits)).toBe("ok");
    expect(await takeDemoUploadQuota(pool, project.id, bob, limits)).toBe("demo_limit");
  });

  it("only apply to demo projects", async () => {
    const { project } = await newProject(pool);
    await expect(
      takeDemoUploadQuota(pool, project.id, randomUUID(), { perUser: 1, perDemo: 1 }),
    ).rejects.toThrow("not a demo project");
  });
});

describe("SECURITY DEFINER entry points", () => {
  it("the API role cannot run the cleanup job (worker only)", async () => {
    const { project } = await newProject(pool);
    await expect(
      withTenant(pool, { projectId: project.id }, (client) =>
        client.query("select reelplane.run_cleanup()"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("rate limit counter", () => {
  it("counts hits in fixed windows", async () => {
    const bucket = `test:${randomUUID()}`;
    const hits: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { rows } = await pool.query<{ hits: number; reset_at: Date }>(
        "select hits, reset_at from reelplane.rate_limit_hit($1, 60)",
        [bucket],
      );
      hits.push(rows[0]?.hits ?? -1);
      expect(rows[0]?.reset_at.getTime()).toBeGreaterThan(Date.now());
    }
    expect(hits).toEqual([1, 2, 3]);
  });
});
