import { buildOpenApi } from "@/lib/server/openapi/spec.ts";

export const dynamic = "force-static";

/** The OpenAPI 3.1 document, generated from the routes themselves (see lib/server/openapi). */
export function GET(): Response {
  return Response.json(buildOpenApi(), {
    headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" },
  });
}
