import { type ApiKeyKind, displayPrefix, generateApiKey, hashApiKey, parseApiKey } from "./keys.ts";
import type { Pool, PoolClient } from "./pool.ts";
import { withTenant } from "./tenant.ts";

export interface ApiKeyRecord {
  id: string;
  projectId: string;
  kind: ApiKeyKind;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

/** Returned only at creation/rotation time: the plaintext key is never retrievable again. */
export interface CreatedApiKey {
  key: string;
  record: ApiKeyRecord;
}

export interface AuthenticatedKey {
  keyId: string;
  projectId: string;
  kind: ApiKeyKind;
  allowedOrigins: string[];
}

interface ApiKeyRow {
  id: string;
  project_id: string;
  kind: ApiKeyKind;
  name: string;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date | null;
}

const KEY_COLUMNS =
  "id, project_id, kind, name, prefix, created_at, last_used_at, revoked_at, expires_at";

function toRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
  };
}

/** Inserts a new key inside an existing tenant transaction. */
export async function insertApiKey(
  client: PoolClient,
  input: { projectId: string; kind: ApiKeyKind; name?: string | undefined },
  pepper: string,
): Promise<CreatedApiKey> {
  const key = generateApiKey(input.kind);
  const { rows } = await client.query<ApiKeyRow>(
    `insert into reelplane.api_keys (project_id, kind, name, prefix, key_hash)
     values ($1, $2, coalesce($3, 'Default'), $4, $5)
     returning ${KEY_COLUMNS}`,
    [input.projectId, input.kind, input.name ?? null, displayPrefix(key), hashApiKey(key, pepper)],
  );
  const row = rows[0];
  if (!row) throw new Error("api key insert returned no row");
  return { key, record: toRecord(row) };
}

export function createApiKey(
  pool: Pool,
  input: { projectId: string; kind: ApiKeyKind; name?: string },
  pepper: string,
): Promise<CreatedApiKey> {
  return withTenant(pool, { projectId: input.projectId }, (client) =>
    insertApiKey(client, input, pepper),
  );
}

export function listApiKeys(pool: Pool, projectId: string): Promise<ApiKeyRecord[]> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<ApiKeyRow>(
      `select ${KEY_COLUMNS} from reelplane.api_keys order by created_at desc`,
    );
    return rows.map(toRecord);
  });
}

/** Revokes a key immediately. Returns false if no such (unrevoked) key exists in the project. */
export function revokeApiKey(pool: Pool, projectId: string, keyId: string): Promise<boolean> {
  return withTenant(pool, { projectId }, async (client) => {
    const result = await client.query(
      "update reelplane.api_keys set revoked_at = now() where id = $1 and revoked_at is null",
      [keyId],
    );
    return result.rowCount === 1;
  });
}

/**
 * Issues a replacement key with the same kind and name. The old key keeps working for
 * `graceSeconds` so deployed clients can switch over without downtime (0 = cut over now).
 */
export function rotateApiKey(
  pool: Pool,
  projectId: string,
  keyId: string,
  pepper: string,
  graceSeconds = 0,
): Promise<CreatedApiKey | null> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<ApiKeyRow>(
      `update reelplane.api_keys
          set expires_at = now() + make_interval(secs => $2)
        where id = $1 and revoked_at is null and (expires_at is null or expires_at > now())
        returning ${KEY_COLUMNS}`,
      [keyId, graceSeconds],
    );
    const old = rows[0];
    if (!old) return null;
    return insertApiKey(client, { projectId, kind: old.kind, name: old.name }, pepper);
  });
}

/**
 * Resolves a raw key to its project. Malformed keys are rejected without a database query.
 * Returns null for unknown, revoked or expired keys (callers answer 401 without saying which).
 */
export async function authenticateApiKey(
  pool: Pool,
  rawKey: string,
  pepper: string,
): Promise<AuthenticatedKey | null> {
  if (!parseApiKey(rawKey)) return null;
  return withTenant(pool, {}, async (client) => {
    const { rows } = await client.query<{
      key_id: string;
      project_id: string;
      kind: ApiKeyKind;
      allowed_origins: string[];
    }>("select * from reelplane.authenticate_api_key($1)", [hashApiKey(rawKey, pepper)]);
    const row = rows[0];
    if (!row) return null;
    return {
      keyId: row.key_id,
      projectId: row.project_id,
      kind: row.kind,
      allowedOrigins: row.allowed_origins,
    };
  });
}
