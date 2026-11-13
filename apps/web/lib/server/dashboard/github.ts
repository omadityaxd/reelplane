import type { SignInWithOAuthCredentials } from "@supabase/supabase-js";

/**
 * What "Sign in with GitHub" asks Supabase for: GitHub, back to /auth/callback (which keeps the
 * allow-listed `next`), and the authorize URL returned to us instead of a browser redirect,
 * because the redirect is issued by a server action.
 */
export function githubSignIn(origin: string, next: string): SignInWithOAuthCredentials {
  return {
    provider: "github",
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
      skipBrowserRedirect: true,
    },
  };
}
