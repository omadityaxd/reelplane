import { randomBytes } from "node:crypto";
import type { Pool } from "./pool.ts";
import { withTenant } from "./tenant.ts";

/** Events a webhook endpoint can subscribe to (queued by the database, see migration 0007). */
export const WEBHOOK_EVENTS = ["video.ready", "video.failed", "video.deleted"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: Date;
}

export type DeliveryState = "pending" | "succeeded" | "dead";

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  state: DeliveryState;
  attempts: number;
  nextAttemptAt: Date;
  lastAttemptAt: Date | null;
  lastStatusCode: number | null;
  lastDurationMs: number | null;
  lastResponse: string | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
  payload: unknown;
}

interface EndpointRow {
  id: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  created_at: Date;
}

const ENDPOINT_COLUMNS = "id, url, events, enabled, created_at";

function toEndpoint(row: EndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    createdAt: row.created_at,
  };
}

/** A new signing secret. Shown in the dashboard; receivers use it to verify signatures. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export function listWebhookEndpoints(pool: Pool, projectId: string): Promise<WebhookEndpoint[]> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<EndpointRow>(
      `select ${ENDPOINT_COLUMNS} from reelplane.webhook_endpoints order by created_at`,
    );
    return rows.map(toEndpoint);
  });
}

/** Endpoints per project; enforced under a lock on the project row, so it holds under races. */
export const MAX_WEBHOOK_ENDPOINTS = 10;

export class TooManyWebhookEndpointsError extends Error {
  override readonly name = "TooManyWebhookEndpointsError";
}

export function createWebhookEndpoint(
  pool: Pool,
  projectId: string,
  input: { url: string; events: readonly WebhookEvent[] },
): Promise<WebhookEndpoint> {
  return withTenant(pool, { projectId }, async (client) => {
    await client.query("select 1 from reelplane.projects where id = $1 for update", [projectId]);
    const { rows: count } = await client.query<{ n: number }>(
      "select count(*)::int as n from reelplane.webhook_endpoints",
    );
    if ((count[0]?.n ?? 0) >= MAX_WEBHOOK_ENDPOINTS) {
      throw new TooManyWebhookEndpointsError(
        `A project can have at most ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints.`,
      );
    }
    const { rows } = await client.query<EndpointRow>(
      `insert into reelplane.webhook_endpoints (project_id, url, secret, events)
       values ($1, $2, $3, $4) returning ${ENDPOINT_COLUMNS}`,
      [projectId, input.url, generateWebhookSecret(), input.events],
    );
    const row = rows[0];
    if (!row) throw new Error("webhook endpoint insert returned no row");
    return toEndpoint(row);
  });
}

/** The signing secret (RLS-scoped to the project, like everything else). */
export function getWebhookSecret(
  pool: Pool,
  projectId: string,
  endpointId: string,
): Promise<string | null> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<{ secret: string }>(
      "select secret from reelplane.webhook_endpoints where id = $1",
      [endpointId],
    );
    return rows[0]?.secret ?? null;
  });
}

export function updateWebhookEndpoint(
  pool: Pool,
  projectId: string,
  endpointId: string,
  patch: { enabled?: boolean; events?: readonly WebhookEvent[]; rollSecret?: boolean },
): Promise<boolean> {
  return withTenant(pool, { projectId }, async (client) => {
    const result = await client.query(
      `update reelplane.webhook_endpoints
          set enabled = coalesce($2, enabled),
              events = coalesce($3, events),
              secret = case when $4 then $5 else secret end
        where id = $1`,
      [
        endpointId,
        patch.enabled ?? null,
        patch.events ?? null,
        patch.rollSecret === true,
        generateWebhookSecret(),
      ],
    );
    return result.rowCount === 1;
  });
}

export function deleteWebhookEndpoint(
  pool: Pool,
  projectId: string,
  endpointId: string,
): Promise<boolean> {
  return withTenant(pool, { projectId }, async (client) => {
    const result = await client.query("delete from reelplane.webhook_endpoints where id = $1", [
      endpointId,
    ]);
    return result.rowCount === 1;
  });
}

/** Queues a `webhook.test` event for one endpoint (the worker sends it like any other). */
export function sendTestWebhook(
  pool: Pool,
  projectId: string,
  endpointId: string,
): Promise<boolean> {
  return withTenant(pool, { projectId }, async (client) => {
    const result = await client.query(
      `insert into reelplane.webhook_deliveries (endpoint_id, project_id, event_type, event_id, payload)
       select e.id, e.project_id, 'webhook.test', ev.id,
              jsonb_build_object('id', ev.id, 'type', 'webhook.test', 'createdAt', now(),
                                 'projectId', e.project_id, 'data', '{}'::jsonb)
         from reelplane.webhook_endpoints e, (select gen_random_uuid() as id) ev
        where e.id = $1`,
      [endpointId],
    );
    return result.rowCount === 1;
  });
}

/** Sends a delivery again now (a dead one, or a succeeded one the receiver lost). */
export function redeliverWebhook(
  pool: Pool,
  projectId: string,
  deliveryId: string,
): Promise<boolean> {
  return withTenant(pool, { projectId }, async (client) => {
    const result = await client.query(
      `update reelplane.webhook_deliveries
          set state = 'pending', next_attempt_at = now(), attempts = 0, delivered_at = null
        where id = $1 and state <> 'pending'`,
      [deliveryId],
    );
    return result.rowCount === 1;
  });
}

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  state: DeliveryState;
  attempts: number;
  next_attempt_at: Date;
  last_attempt_at: Date | null;
  last_status_code: number | null;
  last_duration_ms: number | null;
  last_response: string | null;
  last_error: string | null;
  created_at: Date;
  delivered_at: Date | null;
  payload: unknown;
}

/** The delivery log, newest first (optionally for one endpoint). */
export function listWebhookDeliveries(
  pool: Pool,
  projectId: string,
  options: { endpointId?: string; limit?: number } = {},
): Promise<WebhookDelivery[]> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<DeliveryRow>(
      `select id, endpoint_id, event_id, event_type, state, attempts, next_attempt_at,
              last_attempt_at, last_status_code, last_duration_ms, last_response, last_error,
              created_at, delivered_at, payload
         from reelplane.webhook_deliveries
        where $1::uuid is null or endpoint_id = $1
        order by created_at desc, id
        limit $2`,
      [options.endpointId ?? null, options.limit ?? 50],
    );
    return rows.map((row) => ({
      id: row.id,
      endpointId: row.endpoint_id,
      eventId: row.event_id,
      eventType: row.event_type,
      state: row.state,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      lastAttemptAt: row.last_attempt_at,
      lastStatusCode: row.last_status_code,
      lastDurationMs: row.last_duration_ms,
      lastResponse: row.last_response,
      lastError: row.last_error,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
      payload: row.payload,
    }));
  });
}
