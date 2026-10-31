import type { ApiKeyKind } from "@reelplane/db";
import { type AuthContext, type AuthDeps, authenticateRequest } from "./auth.ts";
import { ApiError } from "./errors.ts";

export interface ApiRouteOptions {
  allow: readonly ApiKeyKind[];
}

export type ApiHandler = (request: Request, auth: AuthContext) => Promise<Response>;

const CORS_MAX_AGE_SECONDS = 600;
const CORS_ALLOWED_HEADERS = "authorization, content-type, idempotency-key";

export function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, init);
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json(
      { error: { code: error.code, message: error.message, details: error.details } },
      { status: error.status },
    );
  }
  // Unexpected errors are logged server-side with detail and returned without it.
  console.error("[api] unhandled error", error);
  return json(
    { error: { code: "internal_error", message: "Something went wrong." } },
    { status: 500 },
  );
}

function withCors(response: Response, origin: string | null): Response {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Wraps a route handler with API key auth, origin checks, CORS and the error envelope.
 * CORS headers are only added once the key has been verified for that origin, so a
 * disallowed site's browser cannot read any response.
 */
export function apiRoute(options: ApiRouteOptions, handler: ApiHandler, deps: () => AuthDeps) {
  return async (request: Request): Promise<Response> => {
    try {
      const auth = await authenticateRequest(request, options, deps());
      return withCors(await handler(request, auth), auth.origin);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/**
 * Preflight cannot carry the API key, so it does not reveal anything: it only says which
 * methods and headers are acceptable. The real request is still origin-checked.
 */
export function corsPreflight(methods: string): (request: Request) => Response {
  return (request) => {
    const origin = request.headers.get("origin");
    const headers = new Headers({
      "access-control-allow-methods": methods,
      "access-control-allow-headers": CORS_ALLOWED_HEADERS,
      "access-control-max-age": String(CORS_MAX_AGE_SECONDS),
      vary: "Origin",
    });
    if (origin) headers.set("access-control-allow-origin", origin);
    return new Response(null, { status: 204, headers });
  };
}
