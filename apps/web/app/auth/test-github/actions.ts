"use server";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { safeNext } from "@/lib/server/dashboard/next-path.ts";
import { authMode } from "@/lib/server/dashboard/session.ts";
import {
  GITHUB_LOGIN,
  signTestSession,
  TEST_SESSION_COOKIE,
  testUserFor,
} from "@/lib/server/dashboard/test-auth.ts";
import { apiKeyPepperFromEnv } from "@/lib/server/env.ts";

/** Test mode only: "authorizes" the login typed on the fake GitHub page and signs it in. */
export async function authorizeTestGitHub(form: FormData): Promise<void> {
  if (authMode() !== "test") notFound();
  const login = String(form.get("login") ?? "").trim();
  const next = safeNext(form.get("next"));
  if (!GITHUB_LOGIN.test(login)) redirect(`/auth/test-github?next=${next}&error=login`);
  (await cookies()).set(
    TEST_SESSION_COOKIE,
    signTestSession(testUserFor(login), apiKeyPepperFromEnv()),
    {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 8 * 3600,
    },
  );
  redirect(next);
}
