"use client";

import { useActionState } from "react";
import { type LoginState, sendMagicLink } from "./actions.ts";

export function LoginForm({ linkError }: { linkError: boolean }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(sendMagicLink, {
    sent: null,
    error: linkError ? "That sign-in link has expired or was already used. Send a new one." : null,
  });
  if (state.sent) {
    return (
      <p className="dash-note" role="status">
        Check <strong>{state.sent}</strong> for a sign-in link. You can close this tab.
      </p>
    );
  }
  return (
    <form action={action} className="dash-form">
      <label className="dash-field">
        <span>Email</span>
        <input type="email" name="email" autoComplete="email" required />
      </label>
      {state.error && (
        <p className="dash-error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" className="dash-button dash-button--primary" disabled={pending}>
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>
    </form>
  );
}
