"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ACTION_RULES, actionAddress, allowAction } from "@/lib/server/dashboard/limits.ts";
import { safeNext } from "@/lib/server/dashboard/next-path.ts";
import { supabaseServerClient } from "@/lib/server/dashboard/supabase.ts";

export interface LoginState {
  sent: string | null;
  error: string | null;
}

const emailSchema = z.email().max(320);

/** Emails a magic link (Supabase Auth). Its link comes back to /auth/callback. */
export async function sendMagicLink(_previous: LoginState, form: FormData): Promise<LoginState> {
  const email = emailSchema.safeParse(String(form.get("email") ?? "").trim());
  if (!email.success) return { sent: null, error: "Enter a valid email address." };
  const inbox = email.data.toLowerCase();
  if (
    !(await allowAction(`signin:${await actionAddress()}`, ACTION_RULES.signInPerAddress)) ||
    !(await allowAction(`signin-email:${inbox}`, ACTION_RULES.signInPerEmail))
  ) {
    return { sent: null, error: "Too many sign-in links requested. Try again in an hour." };
  }
  const origin = await siteOrigin();
  if (!origin)
    return { sent: null, error: "Sign-in isn't fully configured (NEXT_PUBLIC_SITE_URL)." };
  const { error } = await (await supabaseServerClient()).auth.signInWithOtp({
    email: email.data,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(safeNext(form.get("next")))}`,
    },
  });
  if (error) return { sent: null, error: "Couldn't send the link. Try again in a minute." };
  return { sent: email.data, error: null };
}

/**
 * Where the sign-in link points. In production only NEXT_PUBLIC_SITE_URL: the request's Host
 * and X-Forwarded-Host are client-controlled, and a link pointing at another host would hand
 * the sign-in code to it. In development, the origin this request came in on.
 */
async function siteOrigin(): Promise<string | null> {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") return null;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function signOut(): Promise<void> {
  await (await supabaseServerClient()).auth.signOut();
  redirect("/login");
}
