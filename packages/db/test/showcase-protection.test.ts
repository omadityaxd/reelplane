import { describe, expect, it } from "vitest";
import { getFeed, reportVideo, runCleanup, sweepGarbage, withWorker } from "../src/index.ts";
import { insertVideo, newProject, useTestPool } from "./helpers.ts";

const pool = useTestPool();

/**
 * The seeded showcase videos (`is_showcase = true`) are the public demo: the daily cleanup must
 * never delete them and viewer reports must never hide them, however old they get. This runs the
 * cron route's exact sequence (apps/web/app/api/cron/cleanup/route.ts): runCleanup, then
 * sweepGarbage until nothing is left.
 */
describe("showcase videos", () => {
  it("survive the cleanup and any number of reports, at any age", async () => {
    const { project } = await newProject(pool);
    // As the table owner, like the seed: no API path makes a project a demo or a video showcase.
    await pool.query("update reelplane.projects set is_demo = true where id = $1", [project.id]);
    const showcase = await readyVideo(project.id);
    const ordinary = await readyVideo(project.id); // the control: same project, same age
    await pool.query("update reelplane.videos set is_showcase = true where id = $1", [showcase]);
    await pool.query(
      "update reelplane.videos set created_at = now() - interval '10 years' where id = any($1)",
      [[showcase, ordinary]],
    );
    for (let reporter = 0; reporter < 10; reporter += 1) {
      await reportVideo(pool, project.id, showcase, `viewer-${reporter}`, "spam");
    }

    await pool.query("delete from reelplane.maintenance where task = 'cleanup'"); // due now
    const report = await runCleanup(pool, 3600);
    expect(report.ran).toBe(true);
    const removed: string[] = [];
    while ((await sweepGarbage(pool, async (prefix) => removed.push(prefix))) > 0) {}

    const { rows } = await pool.query<{ id: string; status: string; hidden: boolean }>(
      "select id, status, hidden_at is not null as hidden from reelplane.videos where id = any($1)",
      [[showcase, ordinary]],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(showcase)).toMatchObject({ status: "ready", hidden: false });
    expect(byId.get(ordinary)).toMatchObject({ status: "deleted" }); // the cleanup did run
    expect(removed).toContain(`media/${project.id}/${ordinary}/`);
    expect(removed.filter((prefix) => prefix.includes(showcase))).toEqual([]);
    const { rows: queued } = await pool.query(
      "select prefix from reelplane.storage_garbage where prefix like '%' || $1 || '%'",
      [showcase],
    );
    expect(queued).toEqual([]);

    const feed = await getFeed(pool, {
      projectId: project.id,
      feed: { kind: "latest" },
      limit: 10,
    });
    expect(feed.videos.map((video) => video.id)).toEqual([showcase]);
  });
});

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
