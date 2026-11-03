import { NextResponse } from "next/server";
import { safeNext } from "@/lib/server/dashboard/next-path.ts";
import { supabaseServerClient } from "@/lib/server/dashboard/supabase.ts";

export const dynamic = "force-dynamic";

/** The magic link lands here with a one-time `code` (PKCE), exchanged for a session cookie. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (code) {
    const { error } = await (await supabaseServerClient()).auth.exchangeCodeForSession(code);
    if (!error)
      return NextResponse.redirect(new URL(safeNext(url.searchParams.get("next")), url.origin));
  }
  return NextResponse.redirect(new URL("/login?error=link", url.origin));
}
