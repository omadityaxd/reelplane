import type { Pool } from "./pool.ts";
import { withTenant } from "./tenant.ts";

/**
 * Stripe-style idempotency keys. The key row is claimed (committed) before the work starts,
 * so a concurrent retry with the same key sees "in progress" instead of doing the work twice.
 */
export type IdempotencyClaim =
  | { state: "claimed" }
  | { state: "replay"; statusCode: number; response: unknown }
  | { state: "in_progress" }
  | { state: "mismatch" };

export interface IdempotencyScope {
  projectId: string;
  operation: string;
  key: string;
}

/** A claim older than this without a stored response is assumed abandoned (crashed request). */
const STALE_CLAIM_SECONDS = 120;

export function claimIdempotencyKey(
  pool: Pool,
  scope: IdempotencyScope,
  requestHash: string,
): Promise<IdempotencyClaim> {
  return withTenant(pool, { projectId: scope.projectId }, async (client) => {
    const inserted = await client.query(
      `insert into reelplane.idempotency_keys (project_id, operation, key, request_hash)
       values ($1, $2, $3, $4) on conflict do nothing`,
      [scope.projectId, scope.operation, scope.key, requestHash],
    );
    if (inserted.rowCount === 1) return { state: "claimed" };

    const { rows } = await client.query<{
      request_hash: string;
      status_code: number | null;
      response: unknown;
      stale: boolean;
    }>(
      `select request_hash, status_code, response,
              created_at < now() - make_interval(secs => $4) as stale
         from reelplane.idempotency_keys
        where project_id = $1 and operation = $2 and key = $3
        for update`,
      [scope.projectId, scope.operation, scope.key, STALE_CLAIM_SECONDS],
    );
    const existing = rows[0];
    if (!existing) return { state: "in_progress" };
    if (existing.request_hash !== requestHash) return { state: "mismatch" };
    if (existing.status_code !== null) {
      return { state: "replay", statusCode: existing.status_code, response: existing.response };
    }
    if (!existing.stale) return { state: "in_progress" };
    // Take over an abandoned claim.
    await client.query(
      `update reelplane.idempotency_keys set created_at = now()
        where project_id = $1 and operation = $2 and key = $3`,
      [scope.projectId, scope.operation, scope.key],
    );
    return { state: "claimed" };
  });
}

export async function completeIdempotencyKey(
  pool: Pool,
  scope: IdempotencyScope,
  statusCode: number,
  response: unknown,
): Promise<void> {
  await withTenant(pool, { projectId: scope.projectId }, (client) =>
    client.query(
      `update reelplane.idempotency_keys set status_code = $4, response = $5
        where project_id = $1 and operation = $2 and key = $3`,
      [scope.projectId, scope.operation, scope.key, statusCode, JSON.stringify(response)],
    ),
  );
}

/** Releases a claim after a failure so the client's retry can run the operation again. */
export async function releaseIdempotencyKey(pool: Pool, scope: IdempotencyScope): Promise<void> {
  await withTenant(pool, { projectId: scope.projectId }, (client) =>
    client.query(
      `delete from reelplane.idempotency_keys
        where project_id = $1 and operation = $2 and key = $3 and status_code is null`,
      [scope.projectId, scope.operation, scope.key],
    ),
  );
}
