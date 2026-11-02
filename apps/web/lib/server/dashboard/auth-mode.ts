import { supabaseConfig } from "./supabase-config.ts";

/**
 * - `supabase`: sign-in with a magic link (Supabase Auth), when NEXT_PUBLIC_SUPABASE_* are set.
 * - `local`: no sign-in; everyone is the local developer, who owns the seeded demo projects.
 *   Only in `next dev`, or with REELPLANE_LOCAL_AUTH=1, and never on Vercel. Anyone who can
 *   reach the server is that user, so don't expose a local-auth server to a network you
 *   don't trust.
 * - `disabled`: production without Supabase. The dashboard explains what to configure.
 */
export type AuthMode = "supabase" | "local" | "disabled";

/** Owner of the projects `pnpm db:seed` / `pnpm showcase:seed` create. */
export const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";

export function authMode(env: Record<string, string | undefined> = process.env): AuthMode {
  if (supabaseConfig(env)) return "supabase";
  if (env.VERCEL) return "disabled";
  if (env.NODE_ENV !== "production" || env.REELPLANE_LOCAL_AUTH === "1") return "local";
  return "disabled";
}
