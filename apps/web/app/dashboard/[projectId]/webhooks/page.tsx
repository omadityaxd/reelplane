import { listWebhookDeliveries, listWebhookEndpoints } from "@reelplane/db";
import { badgeClass, formatDate, formatDuration } from "@/lib/dashboard/format.ts";
import { requireProject } from "@/lib/server/dashboard/session.ts";
import { appDeps } from "@/lib/server/routes.ts";
import { LiveRefresh } from "../../_components/live-refresh.tsx";
import { RedeliverButton } from "../../_components/redeliver-button.tsx";
import { WebhooksManager } from "../../_components/webhooks-manager.tsx";

export default async function WebhooksPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { project } = await requireProject((await params).projectId);
  const pool = appDeps().pool;
  const [endpoints, deliveries] = await Promise.all([
    listWebhookEndpoints(pool, project.id),
    listWebhookDeliveries(pool, project.id, { limit: 50 }),
  ]);
  const urls = new Map(endpoints.map((e) => [e.id, e.url]));
  const waiting = deliveries.some((d) => d.state === "pending" && d.nextAttemptAt <= new Date());

  return (
    <>
      <p className="dash-note">
        Reelplane POSTs <code>video.ready</code>, <code>video.failed</code> and{" "}
        <code>video.deleted</code> to your endpoints, signed with HMAC-SHA256 (
        <code>Reelplane-Signature</code>). Failed deliveries are retried with backoff (10 attempts,
        up to an hour apart), then marked dead. Deliveries are sent by the worker, so they wait
        while it is off.
      </p>
      <WebhooksManager
        projectId={project.id}
        endpoints={endpoints.map((e) => ({
          id: e.id,
          url: e.url,
          events: e.events,
          enabled: e.enabled,
        }))}
      />
      <section className="dash-card dash-table-wrap">
        <div className="dash-row">
          <h2 style={{ margin: 0 }}>Delivery log</h2>
          <LiveRefresh active={waiting} />
        </div>
        {deliveries.length === 0 ? (
          <p className="dash-empty">No deliveries yet. Send a test event to try an endpoint.</p>
        ) : (
          <table className="dash-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Endpoint</th>
                <th>State</th>
                <th>Last attempt</th>
                <th>Created</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <td>
                    <code>{d.eventType}</code>
                    <div className="mono dash-note" style={{ margin: 0 }}>
                      {d.eventId.slice(0, 8)}
                    </div>
                  </td>
                  <td className="mono" style={{ wordBreak: "break-all" }}>
                    {urls.get(d.endpointId)}
                  </td>
                  <td>
                    <span className={badgeClass(d.state)}>{d.state}</span>
                    <div className="dash-note" style={{ margin: 0 }}>
                      {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
                      {d.state === "pending" && d.attempts > 0
                        ? `, next ${formatDate(d.nextAttemptAt)}`
                        : ""}
                    </div>
                  </td>
                  <td>
                    {d.lastAttemptAt ? (
                      <>
                        {d.lastStatusCode ?? "no response"} · {formatDuration(d.lastDurationMs)}
                        {d.lastError && (
                          <div className="dash-error" style={{ fontSize: "0.85rem" }}>
                            {d.lastError}
                          </div>
                        )}
                      </>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td>{formatDate(d.createdAt)}</td>
                  <td>
                    {d.state !== "pending" && (
                      <RedeliverButton projectId={project.id} deliveryId={d.id} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
