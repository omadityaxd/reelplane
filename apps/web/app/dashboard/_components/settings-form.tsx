"use client";

import { useActionState } from "react";
import { type SettingsState, saveProjectSettings } from "../_actions/projects.ts";

export function SettingsForm({
  projectId,
  name,
  origins,
}: {
  projectId: string;
  name: string;
  origins: string;
}) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(
    saveProjectSettings.bind(null, projectId),
    { error: null, saved: false },
  );
  return (
    <form action={action} className="dash-form">
      <label className="dash-field">
        <span>Project name</span>
        <input type="text" name="name" defaultValue={name} required maxLength={100} />
      </label>
      <label className="dash-field">
        <span>Allowed origins</span>
        <textarea name="origins" defaultValue={origins} placeholder="https://example.com" />
        <span className="dash-note">
          One per line. Browsers on these origins may use your publishable keys and upload tokens.
          Server-side calls (no Origin header) are not affected.
        </span>
      </label>
      {state.error && (
        <p className="dash-error" role="alert">
          {state.error}
        </p>
      )}
      <div className="dash-row">
        <button type="submit" className="dash-button dash-button--primary" disabled={pending}>
          Save
        </button>
        {state.saved && !pending && <span role="status">Saved.</span>}
      </div>
    </form>
  );
}
