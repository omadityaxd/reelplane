"use client";

import { useState, useTransition } from "react";
import {
  createDashboardKey,
  type KeyResult,
  revokeDashboardKey,
  rotateDashboardKey,
} from "../_actions/keys.ts";
import { SecretValue } from "./secret.tsx";

export interface KeyRow {
  id: string;
  kind: "publishable" | "secret";
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** expiring = rotated, still inside its grace period */
  state: "active" | "expiring" | "expired" | "revoked";
  expiresAt: string | null;
}

const GRACE_OPTIONS = [
  { seconds: 0, label: "now" },
  { seconds: 3600, label: "in 1 hour" },
  { seconds: 86_400, label: "in 24 hours" },
  { seconds: 7 * 86_400, label: "in 7 days" },
];

const STATE_BADGE: Record<KeyRow["state"], string> = {
  active: "dash-badge dash-badge--ok",
  expiring: "dash-badge dash-badge--warn",
  expired: "dash-badge",
  revoked: "dash-badge",
};

function when(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })
    : "never";
}

function KeyActions({
  keyRow,
  pending,
  onRotate,
  onRevoke,
}: {
  keyRow: KeyRow;
  pending: boolean;
  onRotate: (seconds: number) => void;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (keyRow.state !== "active") return null;
  return (
    <div className="dash-row">
      <select
        aria-label={`Rotate ${keyRow.name}`}
        defaultValue=""
        disabled={pending}
        style={{ width: "auto" }}
        onChange={(event) => {
          const seconds = Number(event.target.value);
          event.target.value = "";
          onRotate(seconds);
        }}
      >
        <option value="" disabled>
          Rotate…
        </option>
        {GRACE_OPTIONS.map((option) => (
          <option key={option.seconds} value={option.seconds}>
            old key stops {option.label}
          </option>
        ))}
      </select>
      {confirming ? (
        <>
          <button
            type="button"
            className="dash-button dash-button--danger"
            disabled={pending}
            onClick={onRevoke}
          >
            Revoke now
          </button>
          <button type="button" className="dash-button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className="dash-button dash-button--danger"
          onClick={() => setConfirming(true)}
        >
          Revoke
        </button>
      )}
    </div>
  );
}

export function KeysManager({ projectId, keys }: { projectId: string; keys: KeyRow[] }) {
  const [revealed, setRevealed] = useState<{ label: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (label: string, action: () => Promise<KeyResult>) =>
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setRevealed({ label, key: result.key });
        setError(null);
      } else {
        setError(result.error);
      }
    });

  return (
    <>
      {revealed && (
        <div className="dash-secret" role="status">
          <p style={{ marginTop: 0 }}>Copy this key now: it is shown only once.</p>
          <SecretValue label={revealed.label} value={revealed.key} />
        </div>
      )}
      {error && (
        <p className="dash-error" role="alert">
          {error}
        </p>
      )}
      <section className="dash-card">
        <h2>New key</h2>
        <form
          className="dash-row"
          action={(form) =>
            run("New key", () =>
              createDashboardKey(projectId, { kind: form.get("kind"), name: form.get("name") }),
            )
          }
        >
          <select
            name="kind"
            defaultValue="publishable"
            aria-label="Kind"
            style={{ width: "auto" }}
          >
            <option value="publishable">Publishable (browser, read-only feed)</option>
            <option value="secret">Secret (server, full access)</option>
          </select>
          <input
            type="text"
            name="name"
            placeholder="Name, e.g. Production site"
            required
            maxLength={100}
            style={{ width: "auto", flex: 1 }}
          />
          <button type="submit" className="dash-button dash-button--primary" disabled={pending}>
            Create key
          </button>
        </form>
      </section>
      <section className="dash-card dash-table-wrap">
        <table className="dash-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>State</th>
              <th>Last used</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td>
                  {key.name}
                  <div className="dash-note" style={{ margin: 0 }}>
                    {key.kind}
                  </div>
                </td>
                <td className="mono">{key.prefix}…</td>
                <td>
                  <span className={STATE_BADGE[key.state]}>{key.state}</span>
                  {key.state === "expiring" && (
                    <div className="dash-note" style={{ margin: 0 }}>
                      until {when(key.expiresAt)}
                    </div>
                  )}
                </td>
                <td>{when(key.lastUsedAt)}</td>
                <td>
                  <KeyActions
                    keyRow={key}
                    pending={pending}
                    onRotate={(seconds) =>
                      run(`Replacement for ${key.name}`, () =>
                        rotateDashboardKey(projectId, key.id, seconds),
                      )
                    }
                    onRevoke={() => startTransition(() => revokeDashboardKey(projectId, key.id))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
