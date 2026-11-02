import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { authMode, currentUser } from "@/lib/server/dashboard/session.ts";
import "../dashboard/dashboard.css";
import { LoginForm } from "./login-form.tsx";

export const metadata: Metadata = { title: "Sign in · Reelplane" };
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const mode = authMode();
  if (mode === "local" || (await currentUser())) redirect("/dashboard");
  const { error } = await searchParams;
  return (
    <main className="dash dash-login">
      <h1>Sign in to Reelplane</h1>
      {mode === "supabase" ? (
        <LoginForm linkError={error === "link"} />
      ) : (
        <p className="dash-note">
          Sign-in isn't configured on this server. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> (see <code>.env.example</code>), or run{" "}
          <code>next dev</code> locally, where the dashboard needs no sign-in.
        </p>
      )}
    </main>
  );
}
