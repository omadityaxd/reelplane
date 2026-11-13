import { supabaseConfig } from "./supabase-config.ts";

/**
 * - `test`: GitHub sign-in is simulated by a local consent page (REELPLANE_TEST_AUTH=1), so the
 *   whole flow can be tested without GitHub credentials. Never on Vercel, and only against a
 *   local database: test sessions are minted by this server for any GitHub login you type.
 * - `supabase`: Sign in with GitHub (and email links) through Supabase Auth, when
 *   NEXT_PUBLIC_SUPABASE_* are set.
 * - `local`: no sign-in; everyone is the local developer, who owns the seeded demo projects.
 *   Only in `next dev`, or with REELPLANE_LOCAL_AUTH=1, and never on Vercel. Anyone who can
 *   reach the server is that user, so don't expose a local-auth server to a network you
 *   don't trust.
 * - `disabled`: production without Supabase. The dashboard explains what to configure.
 */
export type AuthMode = "test" | "supabase" | "local" | "disabled";

/** Owner of the projects `pnpm db:seed` / `pnpm showcase:seed` create. */
export const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

/** No DATABASE_URL means the local Docker Postgres; otherwise its host must be local. */
function isLocalDatabase(url: string | undefined): boolean {
  if (!url) return true;
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function authMode(env: Record<string, string | undefined> = process.env): AuthMode {
  if (env.REELPLANE_TEST_AUTH === "1" && !env.VERCEL && isLocalDatabase(env.DATABASE_URL)) {
    return "test";
  }
  if (supabaseConfig(env)) return "supabase";
  if (env.VERCEL) return "disabled";
  if (env.NODE_ENV !== "production" || env.REELPLANE_LOCAL_AUTH === "1") return "local";
  return "disabled";
}
