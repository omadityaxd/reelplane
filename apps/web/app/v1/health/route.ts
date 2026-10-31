import { db } from "@/lib/server/db.ts";

export const dynamic = "force-dynamic";

/** Liveness + database reachability. No auth, no detail beyond up/down. */
export async function GET(): Promise<Response> {
  try {
    await db().query("select 1");
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "degraded", database: "unreachable" }, { status: 503 });
  }
}
