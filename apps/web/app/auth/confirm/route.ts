import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { safeNext } from "@/lib/server/dashboard/next-path.ts";
import { supabaseServerClient } from "@/lib/server/dashboard/supabase.ts";

export const dynamic = "force-dynamic";

const TYPES = new Set<EmailOtpType>(["magiclink", "email", "signup"]);

/**
 * Sign-in link that works on any device. Supabase's default magic link uses PKCE, which only
 * completes in the browser that asked for it (requesting on a laptop and opening the email on
 * a phone fails). With the email template pointing here
 * (`{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`), the server verifies the
 * one-time token itself and sets the session cookie. See .env.example.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  if (tokenHash && type && TYPES.has(type)) {
    const { error } = await (await supabaseServerClient()).auth.verifyOtp({
      token_hash: tokenHash,
      type,
    });
    if (!error)
      return NextResponse.redirect(new URL(safeNext(url.searchParams.get("next")), url.origin));
  }
  return NextResponse.redirect(new URL("/login?error=link", url.origin));
}
