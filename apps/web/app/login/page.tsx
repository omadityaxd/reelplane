import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safeNext } from "@/lib/server/dashboard/next-path.ts";
import { authMode, currentUser } from "@/lib/server/dashboard/session.ts";
import "../dashboard/dashboard.css";
import { signInWithGitHub } from "./actions.ts";
import { LoginForm } from "./login-form.tsx";

export const metadata: Metadata = { title: "Sign in · Reelplane" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  link: "That sign-in link has expired or was already used. Try again.",
  github: "GitHub sign-in didn't start. Try again in a minute.",
  config: "Sign-in isn't fully configured on this server (NEXT_PUBLIC_SITE_URL).",
};

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next: requested } = await searchParams;
  const next = safeNext(requested);
  const mode = authMode();
  if (mode === "local" || (await currentUser())) redirect(next);
  if (mode === "disabled") {
    return (
      <main className="dash dash-login">
        <h1>Sign in to Reelplane</h1>
        <p className="dash-note">
          Sign-in isn't configured on this server. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> (see <code>.env.example</code>), or run{" "}
          <code>next dev</code> locally, where the dashboard needs no sign-in.
        </p>
      </main>
    );
  }
  const message = error ? ERRORS[error] : undefined;
  return (
    <main className="dash dash-login">
      <h1>Sign in to Reelplane</h1>
      {mode === "test" && (
        <p className="dash-badge dash-badge--warn">Test mode: GitHub is simulated locally</p>
      )}
      {message && (
        <p className="dash-error" role="alert">
          {message}
        </p>
      )}
      <form action={signInWithGitHub} className="dash-form">
        <input type="hidden" name="next" value={next} />
        <button type="submit" className="dash-button dash-button--primary dash-button--wide">
          <GitHubIcon />
          Sign in with GitHub
        </button>
      </form>
      {mode === "supabase" && (
        <details className="dash-login-email">
          <summary>Or get a sign-in link by email</summary>
          <LoginForm linkError={false} next={next} />
        </details>
      )}
    </main>
  );
}
