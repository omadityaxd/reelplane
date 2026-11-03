import { db } from "@/lib/server/db.ts";
import { CLIENT_RULE, clientAddress, PostgresRateLimiter } from "@/lib/server/rate-limit.ts";

export const dynamic = "force-dynamic";

/** Liveness + database reachability. No auth, no detail beyond up/down; limited per address. */
export async function GET(request: Request): Promise<Response> {
  try {
    const limit = await new PostgresRateLimiter(db()).hit(
      `health:${clientAddress(request)}`,
      CLIENT_RULE.limit,
      CLIENT_RULE.windowSeconds,
    );
    if (!limit.allowed) return Response.json({ status: "rate_limited" }, { status: 429 });
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "degraded", database: "unreachable" }, { status: 503 });
  }
}
