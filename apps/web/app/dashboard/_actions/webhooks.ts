"use server";

import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookSecret,
  redeliverWebhook,
  sendTestWebhook,
  TooManyWebhookEndpointsError,
  updateWebhookEndpoint,
  WEBHOOK_EVENTS,
} from "@reelplane/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ACTION_RULES, allowAction } from "@/lib/server/dashboard/limits.ts";
import { authMode, requireProject } from "@/lib/server/dashboard/session.ts";
import { db } from "@/lib/server/db.ts";

const TOO_MANY = "Too many changes in a short time. Wait a minute and try again.";

export type WebhookResult = { ok: true; secret?: string } | { ok: false; error: string };

const UUID = z.uuid();
const createSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).max(2000),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, "Pick at least one event."),
});

function done(projectId: string): void {
  revalidatePath(`/dashboard/${projectId}/webhooks`);
}

/** Adds an endpoint and returns its signing secret. HTTPS only, except in local development. */
export async function createDashboardWebhook(
  projectId: string,
  input: unknown,
): Promise<WebhookResult> {
  const { user } = await requireProject(projectId);
  if (!(await allowAction(`dashboard:${user.id}`, ACTION_RULES.dashboardWrite)))
    return { ok: false, error: TOO_MANY };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid endpoint." };
  }
  if (!parsed.data.url.startsWith("https://") && authMode() !== "local") {
    return { ok: false, error: "Webhook URLs must use https://." };
  }
  let endpoint: Awaited<ReturnType<typeof createWebhookEndpoint>>;
  try {
    endpoint = await createWebhookEndpoint(db(), projectId, parsed.data);
  } catch (error) {
    if (error instanceof TooManyWebhookEndpointsError) return { ok: false, error: error.message };
    throw error;
  }
  done(projectId);
  const secret = await getWebhookSecret(db(), projectId, endpoint.id);
  return { ok: true, ...(secret ? { secret } : {}) };
}

export async function revealWebhookSecret(
  projectId: string,
  endpointId: string,
): Promise<WebhookResult> {
  await requireProject(projectId);
  const secret = UUID.safeParse(endpointId).success
    ? await getWebhookSecret(db(), projectId, endpointId)
    : null;
  return secret ? { ok: true, secret } : { ok: false, error: "Endpoint not found." };
}

export async function rollWebhookSecret(
  projectId: string,
  endpointId: string,
): Promise<WebhookResult> {
  await requireProject(projectId);
  if (!UUID.safeParse(endpointId).success) return { ok: false, error: "Endpoint not found." };
  await updateWebhookEndpoint(db(), projectId, endpointId, { rollSecret: true });
  return revealWebhookSecret(projectId, endpointId);
}

export async function setWebhookEnabled(
  projectId: string,
  endpointId: string,
  enabled: boolean,
): Promise<void> {
  await requireProject(projectId);
  if (UUID.safeParse(endpointId).success) {
    await updateWebhookEndpoint(db(), projectId, endpointId, { enabled: enabled === true });
  }
  done(projectId);
}

export async function deleteDashboardWebhook(projectId: string, endpointId: string): Promise<void> {
  await requireProject(projectId);
  if (UUID.safeParse(endpointId).success) await deleteWebhookEndpoint(db(), projectId, endpointId);
  done(projectId);
}

export async function sendDashboardTestWebhook(
  projectId: string,
  endpointId: string,
): Promise<void> {
  const { user } = await requireProject(projectId);
  if (!(await allowAction(`dashboard:${user.id}`, ACTION_RULES.dashboardWrite))) return;
  if (UUID.safeParse(endpointId).success) await sendTestWebhook(db(), projectId, endpointId);
  done(projectId);
}

export async function redeliverDashboardWebhook(
  projectId: string,
  deliveryId: string,
): Promise<void> {
  await requireProject(projectId);
  if (UUID.safeParse(deliveryId).success) await redeliverWebhook(db(), projectId, deliveryId);
  done(projectId);
}
