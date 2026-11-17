/**
 * Security headers for every response, built from the same env vars the app uses, so the
 * Content-Security-Policy allows exactly this deployment's Supabase and storage hosts.
 *
 * What the pages load from elsewhere:
 * - Supabase (auth): fetches from the browser, and the GitHub sign-in redirect.
 * - Storage: HLS playlists and segments (fetched by hls.js, or played natively), posters, the
 *   browser's direct part uploads, and presigned previews.
 * - `blob:`: hls.js plays through MediaSource and may run a worker from a blob; the dashboard
 *   previews a picked file through an object URL.
 *
 * `script-src` keeps 'unsafe-inline' because Next.js inlines its bootstrap scripts; a nonce would
 * make every page dynamic. External scripts are still refused, and the app renders no raw HTML.
 * `style-src` needs it for the `<style>` the layout and `<ReelFeed>` render.
 */
type Env = Record<string, string | undefined>;

export interface Header {
  key: string;
  value: string;
}

function origin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(env: Env): string {
  const supabase = origin(env.NEXT_PUBLIC_SUPABASE_URL);
  const storage = [origin(env.STORAGE_PUBLIC_BASE_URL), origin(env.STORAGE_ENDPOINT)].filter(
    (value): value is string => value !== null,
  );
  const remote = [...new Set([...(supabase ? [supabase] : []), ...storage])];
  const media = [...new Set(storage)];
  const list = (...sources: string[]) => sources.join(" ");
  const directives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${list("'self'", "data:", "blob:", ...media)}`,
    `media-src ${list("'self'", "blob:", ...media)}`,
    `connect-src ${list("'self'", ...remote)}`,
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    // Without JavaScript the GitHub sign-in is a form POST that redirects to Supabase, then GitHub.
    `form-action ${list("'self'", ...(supabase ? [supabase, "https://github.com"] : []))}`,
    "frame-ancestors 'none'",
  ];
  if ([...remote].every((source) => source.startsWith("https://"))) {
    directives.push("upgrade-insecure-requests");
  }
  return directives.join("; ");
}

export function securityHeaders(env: Env): Header[] {
  const headers: Header[] = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    // Ignored over plain http, so harmless locally.
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  ];
  // The dev server needs eval and its own websocket; the policy is for builds (next start, Vercel).
  if (env.NODE_ENV === "production") {
    headers.push({ key: "Content-Security-Policy", value: contentSecurityPolicy(env) });
  }
  return headers;
}
