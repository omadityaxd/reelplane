/**
 * Where to go after signing in. Only these paths: anything taken from a URL and used as a
 * redirect would otherwise be an open redirect (`?next=https://evil.example`).
 */
const ALLOWED = ["/dashboard", "/upload"] as const;

export function safeNext(value: unknown): string {
  return ALLOWED.find((path) => path === value) ?? "/dashboard";
}
