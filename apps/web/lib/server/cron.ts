/** Vercel cron requests carry `Authorization: Bearer $CRON_SECRET`; refuse anything else. */
export function cronAuthError(request: Request, secret: string | undefined): Response | null {
  if (!secret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
