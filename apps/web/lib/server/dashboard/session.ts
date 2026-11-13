import "server-only";
import { getOwnedProject, type Project } from "@reelplane/db";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { db } from "../db.ts";
import { apiKeyPepperFromEnv } from "../env.ts";
import { type AuthMode, authMode, LOCAL_USER_ID } from "./auth-mode.ts";
import { supabaseServerClient } from "./supabase.ts";
import { readTestSession, TEST_SESSION_COOKIE } from "./test-auth.ts";

export { type AuthMode, authMode, LOCAL_USER_ID };

export interface DashboardUser {
  id: string;
  email: string | null;
  /** The GitHub login, when signed in with GitHub. */
  githubLogin: string | null;
}

/** The signed-in user, or null. Cached per request. */
export const currentUser = cache(async (): Promise<DashboardUser | null> => {
  const mode = authMode();
  if (mode === "local") return { id: LOCAL_USER_ID, email: null, githubLogin: null };
  if (mode === "disabled") return null;
  if (mode === "test") {
    const cookie = (await cookies()).get(TEST_SESSION_COOKIE)?.value;
    const user = readTestSession(cookie, apiKeyPepperFromEnv());
    return user ? { id: user.id, email: user.email, githubLogin: user.login } : null;
  }
  // getUser() asks Supabase to validate the token, unlike getSession(), which trusts the cookie.
  const { data, error } = await (await supabaseServerClient()).auth.getUser();
  if (error || !data.user) return null;
  const login = data.user.user_metadata?.user_name;
  return {
    id: data.user.id,
    email: data.user.email ?? null,
    githubLogin: typeof login === "string" ? login : null,
  };
});

export async function requireUser(): Promise<DashboardUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * The project, if the signed-in user owns it. Every dashboard page and server action calls
 * this with the id it was given: a project id from the URL or a form is never trusted.
 * Someone else's project answers 404, like one that doesn't exist.
 */
export const requireProject = cache(
  async (projectId: string): Promise<{ user: DashboardUser; project: Project }> => {
    const user = await requireUser();
    const project = UUID.test(projectId) ? await getOwnedProject(db(), user.id, projectId) : null;
    if (!project) notFound();
    return { user, project };
  },
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
