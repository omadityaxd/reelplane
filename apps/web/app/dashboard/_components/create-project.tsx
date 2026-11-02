"use client";

import Link from "next/link";
import { useActionState } from "react";
import { type CreatedProjectState, createDashboardProject } from "../_actions/projects.ts";
import { SecretValue } from "./secret.tsx";

export function CreateProject() {
  const [state, action, pending] = useActionState<CreatedProjectState, FormData>(
    createDashboardProject,
    { error: null, created: null },
  );
  return (
    <>
      {state.created && (
        <div className="dash-secret" role="status">
          <p style={{ marginTop: 0 }}>
            <strong>{state.created.name}</strong> is ready. Copy the secret key now: it is shown
            only once (you can create new keys later).
          </p>
          <SecretValue label="Publishable key (browser)" value={state.created.publishableKey} />
          <SecretValue label="Secret key (server only)" value={state.created.secretKey} />
          <p style={{ marginBottom: 0 }}>
            <Link href={`/dashboard/${state.created.projectId}`}>Open the project →</Link>
          </p>
        </div>
      )}
      <form action={action} className="dash-row">
        <input type="text" name="name" placeholder="New project name" required maxLength={100} />
        <button type="submit" className="dash-button dash-button--primary" disabled={pending}>
          Create project
        </button>
        {state.error && <p className="dash-error">{state.error}</p>}
      </form>
    </>
  );
}
