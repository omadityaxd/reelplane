"use client";

import { useState, useTransition } from "react";
import {
  createDashboardWebhook,
  deleteDashboardWebhook,
  revealWebhookSecret,
  rollWebhookSecret,
  sendDashboardTestWebhook,
  setWebhookEnabled,
  type WebhookResult,
} from "../_actions/webhooks.ts";
import { SecretValue } from "./secret.tsx";

export interface EndpointRow {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
}

const EVENTS = ["video.ready", "video.failed", "video.deleted"];

function EndpointActions({
  projectId,
  endpoint,
  pending,
  run,
  onSecret,
}: {
  projectId: string;
  endpoint: EndpointRow;
  pending: boolean;
  run: (action: () => Promise<unknown>) => void;
  onSecret: (action: () => Promise<WebhookResult>) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="dash-row">
      <button
        type="button"
        className="dash-button"
        disabled={pending}
        onClick={() => run(() => sendDashboardTestWebhook(projectId, endpoint.id))}
      >
        Send test event
      </button>
      <button
        type="button"
        className="dash-button"
        disabled={pending}
        onClick={() => onSecret(() => revealWebhookSecret(projectId, endpoint.id))}
      >
        Show secret
      </button>
      <button
        type="button"
        className="dash-button"
        disabled={pending}
        onClick={() => onSecret(() => rollWebhookSecret(projectId, endpoint.id))}
      >
        Roll secret
      </button>
      <button
        type="button"
        className="dash-button"
        disabled={pending}
        onClick={() => run(() => setWebhookEnabled(projectId, endpoint.id, !endpoint.enabled))}
      >
        {endpoint.enabled ? "Disable" : "Enable"}
      </button>
      {confirmDelete ? (
        <>
          <button
            type="button"
            className="dash-button dash-button--danger"
            disabled={pending}
            onClick={() => run(() => deleteDashboardWebhook(projectId, endpoint.id))}
          >
            Delete endpoint and its log
          </button>
          <button type="button" className="dash-button" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className="dash-button dash-button--danger"
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </button>
      )}
    </div>
  );
}

export function WebhooksManager({
  projectId,
  endpoints,
}: {
  projectId: string;
  endpoints: EndpointRow[];
}) {
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<unknown>) =>
    startTransition(async () => void (await action()));
  const onSecret = (action: () => Promise<WebhookResult>) =>
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setSecret(result.secret ?? null);
        setError(null);
      } else {
        setError(result.error);
      }
    });

  return (
    <>
      {secret && (
        <div className="dash-secret" role="status">
          <p style={{ marginTop: 0 }}>
            Verify each delivery with this secret (<code>verifyWebhook()</code> from{" "}
            <code>@reelplane/sdk-core</code>).
          </p>
          <SecretValue label="Signing secret" value={secret} />
        </div>
      )}
      {error && (
        <p className="dash-error" role="alert">
          {error}
        </p>
      )}
      <section className="dash-card">
        <h2>Add an endpoint</h2>
        <form
          className="dash-form"
          action={(form) =>
            onSecret(() =>
              createDashboardWebhook(projectId, {
                url: String(form.get("url") ?? "").trim(),
                events: form.getAll("events"),
              }),
            )
          }
        >
          <label className="dash-field">
            <span>URL</span>
            <input
              type="url"
              name="url"
              placeholder="https://example.com/webhooks/reelplane"
              required
            />
          </label>
          <fieldset className="dash-checks" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="dash-note">Events</legend>
            {EVENTS.map((event) => (
              <label key={event}>
                <input type="checkbox" name="events" value={event} defaultChecked /> {event}
              </label>
            ))}
          </fieldset>
          <div>
            <button type="submit" className="dash-button dash-button--primary" disabled={pending}>
              Add endpoint
            </button>
          </div>
        </form>
      </section>
      {endpoints.map((endpoint) => (
        <section key={endpoint.id} className="dash-card">
          <div className="dash-row dash-row--between">
            <div>
              <div className="mono" style={{ wordBreak: "break-all" }}>
                {endpoint.url}
              </div>
              <div className="dash-note" style={{ margin: 0 }}>
                {endpoint.events.join(", ")}{" "}
                {!endpoint.enabled && <span className="dash-badge">disabled</span>}
              </div>
            </div>
            <EndpointActions
              projectId={projectId}
              endpoint={endpoint}
              pending={pending}
              run={run}
              onSecret={onSecret}
            />
          </div>
        </section>
      ))}
    </>
  );
}
