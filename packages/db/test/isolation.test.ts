import { describe, expect, inject, it } from "vitest";
import { createPool, withTenant, withWorker } from "../src/index.ts";
import { insertVideo, newProject, useTestPool } from "./helpers.ts";

const pool = useTestPool();

/** Cross-project isolation is enforced by Postgres RLS, not by remembering WHERE clauses. */
describe("row-level security", () => {
  it("a project cannot read another project's videos, even without a WHERE clause", async () => {
    const a = await newProject(pool);
    const b = await newProject(pool);
    const videoA = await insertVideo(pool, a.project.id);
    const videoB = await insertVideo(pool, b.project.id);

    const visibleToA = await withTenant(pool, { projectId: a.project.id }, async (client) => {
      const { rows } = await client.query<{ id: string }>("select id from reelplane.videos");
      return rows.map((row) => row.id);
    });

    expect(visibleToA).toContain(videoA);
    expect(visibleToA).not.toContain(videoB);
  });

  it("a project cannot fetch another project's video by id", async () => {
    const a = await newProject(pool);
    const b = await newProject(pool);
    const videoB = await insertVideo(pool, b.project.id);

    const rows = await withTenant(pool, { projectId: a.project.id }, async (client) => {
      const result = await client.query("select * from reelplane.videos where id = $1", [videoB]);
      return result.rows;
    });
    expect(rows).toEqual([]);
  });

  it("a project cannot update or delete another project's video", async () => {
    const a = await newProject(pool);
    const b = await newProject(pool);
    const videoB = await insertVideo(pool, b.project.id);

    const counts = await withTenant(pool, { projectId: a.project.id }, async (client) => {
      const updated = await client.query(
        "update reelplane.videos set title = 'pwned' where id = $1",
        [videoB],
      );
      const deleted = await client.query("delete from reelplane.videos where id = $1", [videoB]);
      return [updated.rowCount, deleted.rowCount];
    });
    expect(counts).toEqual([0, 0]);
  });

  it("a project cannot write rows into another project", async () => {
    const a = await newProject(pool);
    const b = await newProject(pool);

    await expect(insertVideoAs(a.project.id, b.project.id)).rejects.toThrow(/row-level security/);
  });

  it("no tenant context means no rows at all", async () => {
    const a = await newProject(pool);
    await insertVideo(pool, a.project.id);

    const count = await withTenant(pool, {}, async (client) => {
      const { rows } = await client.query<{ n: number }>(
        "select count(*)::int as n from reelplane.videos",
      );
      return rows[0]?.n;
    });
    expect(count).toBe(0);
  });

  it("a dashboard user sees only the projects they own", async () => {
    const a = await newProject(pool);
    await newProject(pool);

    const ids = await withTenant(pool, { userId: a.project.ownerId }, async (client) => {
      const { rows } = await client.query<{ id: string }>("select id from reelplane.projects");
      return rows.map((row) => row.id);
    });
    expect(ids).toEqual([a.project.id]);
  });

  it("the tenant scope does not leak to the next transaction on a pooled connection", async () => {
    const a = await newProject(pool);
    await insertVideo(pool, a.project.id);
    const single = createPool(inject("databaseUrl"), { max: 1 });
    try {
      await withTenant(single, { projectId: a.project.id }, (client) => client.query("select 1"));
      const after = await single.query<{ project: string | null; role: string }>(
        "select current_setting('app.project_id', true) as project, current_user as role",
      );
      expect(after.rows[0]?.project ?? "").toBe("");
      expect(after.rows[0]?.role).not.toBe("reelplane_api");
    } finally {
      await single.end();
    }
  });

  it("the worker role sees every project's videos", async () => {
    const a = await newProject(pool);
    const b = await newProject(pool);
    const ids = [await insertVideo(pool, a.project.id), await insertVideo(pool, b.project.id)];

    const visible = await withWorker(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        "select id from reelplane.videos where id = any($1)",
        [ids],
      );
      return rows.map((row) => row.id).sort();
    });
    expect(visible).toEqual([...ids].sort());
  });

  it("the worker role cannot read API keys", async () => {
    await expect(
      withWorker(pool, (client) => client.query("select * from reelplane.api_keys")),
    ).rejects.toThrow(/permission denied/);
  });
});

function insertVideoAs(scopeProjectId: string, targetProjectId: string) {
  return withTenant(pool, { projectId: scopeProjectId }, (client) =>
    client.query(
      `insert into reelplane.videos (project_id, content_type, size_bytes, source_key)
       values ($1, 'video/mp4', 1, 'originals/x')`,
      [targetProjectId],
    ),
  );
}
