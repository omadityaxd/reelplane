import { type CreatedApiKey, insertApiKey } from "./api-keys.ts";
import type { Pool } from "./pool.ts";
import { withTenant } from "./tenant.ts";

export interface Project {
  id: string;
  name: string;
  ownerId: string;
  allowedOrigins: string[];
  isDemo: boolean;
  createdAt: Date;
}

export interface CreatedProject {
  project: Project;
  publishableKey: CreatedApiKey;
  secretKey: CreatedApiKey;
}

interface ProjectRow {
  id: string;
  name: string;
  owner_id: string;
  allowed_origins: string[];
  is_demo: boolean;
  created_at: Date;
}

const PROJECT_COLUMNS = "id, name, owner_id, allowed_origins, is_demo, created_at";

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    allowedOrigins: row.allowed_origins,
    isDemo: row.is_demo,
    createdAt: row.created_at,
  };
}

/** Allowed origins are compared verbatim against the browser's Origin header. */
export function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`origin must be http(s): ${origin}`);
  }
  return url.origin;
}

/** Creates a project owned by a dashboard user, plus one publishable and one secret key. */
export function createProject(
  pool: Pool,
  input: { ownerId: string; name: string; allowedOrigins?: string[]; isDemo?: boolean },
  pepper: string,
): Promise<CreatedProject> {
  const allowedOrigins = [...new Set((input.allowedOrigins ?? []).map(normalizeOrigin))];
  return withTenant(pool, { userId: input.ownerId }, async (client) => {
    const { rows } = await client.query<ProjectRow>(
      `insert into reelplane.projects (name, owner_id, allowed_origins, is_demo)
       values ($1, $2, $3, $4)
       returning ${PROJECT_COLUMNS}`,
      [input.name, input.ownerId, allowedOrigins, input.isDemo ?? false],
    );
    const row = rows[0];
    if (!row) throw new Error("project insert returned no row");
    // Keys are inserted under the new project's scope.
    await client.query("select set_config('app.project_id', $1, true)", [row.id]);
    const publishableKey = await insertApiKey(
      client,
      { projectId: row.id, kind: "publishable" },
      pepper,
    );
    const secretKey = await insertApiKey(client, { projectId: row.id, kind: "secret" }, pepper);
    return { project: toProject(row), publishableKey, secretKey };
  });
}

export function getProject(pool: Pool, projectId: string): Promise<Project | null> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<ProjectRow>(
      `select ${PROJECT_COLUMNS} from reelplane.projects where id = $1`,
      [projectId],
    );
    return rows[0] ? toProject(rows[0]) : null;
  });
}

/** Replaces a project's allowed browser origins (dashboard user scope). */
export function setAllowedOrigins(
  pool: Pool,
  ownerId: string,
  projectId: string,
  origins: string[],
): Promise<Project | null> {
  const normalized = [...new Set(origins.map(normalizeOrigin))];
  return withTenant(pool, { userId: ownerId }, async (client) => {
    const { rows } = await client.query<ProjectRow>(
      `update reelplane.projects set allowed_origins = $2 where id = $1 returning ${PROJECT_COLUMNS}`,
      [projectId, normalized],
    );
    return rows[0] ? toProject(rows[0]) : null;
  });
}

export function listProjectsForUser(pool: Pool, userId: string): Promise<Project[]> {
  return withTenant(pool, { userId }, async (client) => {
    const { rows } = await client.query<ProjectRow>(
      `select ${PROJECT_COLUMNS} from reelplane.projects where owner_id = $1 order by created_at`,
      [userId],
    );
    return rows.map(toProject);
  });
}
