import { randomUUID } from "node:crypto";
import { afterAll, inject } from "vitest";
import { createPool, type Pool, withTenant } from "../src/index.ts";
import { type CreatedProject, createProject } from "../src/projects.ts";

export const TEST_PEPPER = "test-pepper-0123456789abcdef0123456789";

/** One pool per test file, closed automatically. */
export function useTestPool(): Pool {
  const pool = createPool(inject("databaseUrl"), { max: 4 });
  afterAll(() => pool.end());
  return pool;
}

export function newProject(
  pool: Pool,
  overrides: { allowedOrigins?: string[] } = {},
): Promise<CreatedProject> {
  return createProject(
    pool,
    { ownerId: randomUUID(), name: `test-${randomUUID().slice(0, 8)}`, ...overrides },
    TEST_PEPPER,
  );
}

/** Inserts a video directly (the upload path arrives in Phase 3). */
export async function insertVideo(
  pool: Pool,
  projectId: string,
  status = "uploading",
): Promise<string> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into reelplane.videos (project_id, content_type, size_bytes, source_key, status)
       values ($1, 'video/mp4', 1024, 'originals/x', $2) returning id`,
      [projectId, status],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("video insert returned no row");
    return id;
  });
}
