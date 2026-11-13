import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { safeNext } from "@/lib/server/dashboard/next-path.ts";
import { authMode } from "@/lib/server/dashboard/session.ts";
import "../../dashboard/dashboard.css";
import { authorizeTestGitHub } from "./actions.ts";

export const metadata: Metadata = { title: "Authorize Reelplane (test mode)" };
export const dynamic = "force-dynamic";

/**
 * Stands in for GitHub's consent screen when REELPLANE_TEST_AUTH=1, so sign-in can be tested
 * end to end locally. 404 in every other mode.
 */
export default async function TestGitHubPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  if (authMode() !== "test") notFound();
  const { next, error } = await searchParams;
  return (
    <main className="dash dash-login">
      <p className="dash-badge dash-badge--warn">Test mode: this is not GitHub</p>
      <h1>Authorize Reelplane</h1>
      <p className="dash-note">
        Reelplane would like to read your GitHub profile and email. Sign in as any GitHub login:
        each one is a separate test user.
      </p>
      <form action={authorizeTestGitHub} className="dash-form">
        <input type="hidden" name="next" value={safeNext(next)} />
        <label className="dash-field">
          <span>GitHub login</span>
          <input type="text" name="login" defaultValue="octocat" required maxLength={39} />
        </label>
        {error === "login" && (
          <p className="dash-error" role="alert">
            Use letters, digits and single hyphens, like a GitHub login.
          </p>
        )}
        <button type="submit" className="dash-button dash-button--primary">
          Authorize
        </button>
      </form>
    </main>
  );
}
