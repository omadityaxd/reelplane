import type { Pool, PoolClient } from "./pool.ts";

export interface TenantContext {
  /** The project whose rows this transaction may see (API key requests). */
  projectId?: string | undefined;
  /** The signed-in dashboard user (sees the projects they own). */
  userId?: string | undefined;
}

async function inTransaction<T>(
  pool: Pool,
  setup: (client: PoolClient) => Promise<void>,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await setup(client);
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs `run` in a transaction as the RLS-restricted `reelplane_api` role, scoped to one
 * project and/or dashboard user. `SET LOCAL` means the scope ends with the transaction, so a
 * pooled connection can never leak one tenant's context into the next request.
 */
export function withTenant<T>(
  pool: Pool,
  context: TenantContext,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inTransaction(
    pool,
    async (client) => {
      await client.query("set local role reelplane_api");
      await client.query(
        "select set_config('app.project_id', $1, true), set_config('app.user_id', $2, true)",
        [context.projectId ?? "", context.userId ?? ""],
      );
    },
    run,
  );
}

/** Runs `run` in a transaction as the `reelplane_worker` role (all projects, limited tables). */
export function withWorker<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction(
    pool,
    (client) => client.query("set local role reelplane_worker").then(() => undefined),
    run,
  );
}
