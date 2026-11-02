import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseConfig } from "./supabase-config.ts";

/** A Supabase client bound to this request's auth cookies (create one per request). */
export async function supabaseServerClient() {
  const config = supabaseConfig();
  if (!config) throw new Error("Supabase Auth is not configured (NEXT_PUBLIC_SUPABASE_*).");
  const store = await cookies();
  return createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Server components can't set cookies; proxy.ts refreshes the session instead.
        }
      },
    },
  });
}
