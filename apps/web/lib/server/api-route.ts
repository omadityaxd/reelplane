import { type AuthContext, type AuthDeps, authenticateRequest, type Credential } from "./auth.ts";
import { ApiError } from "./errors.ts";
import {
  CLIENT_RULE,
  clientAddress,
  enforce,
  RateLimitedError,
  type RateLimitResult,
  type RateLimitRule,
  rateLimitHeaders,
} from "./rate-limit.ts";

export interface ApiRouteOptions {
  allow: readonly Credential[];
  /** Required: every route is rate limited (see rate-limit.ts). */
  rateLimit: RateLimitRule;
  /** Route param holding the video id an upload token must match (e.g. "id"). */
  uploadTokenParam?: string;
  /** See AuthOptions.allowQueryKey. */
  allowQueryKey?: boolean;
}

type Params = Record<string, string | string[] | undefined>;

/**
 * Next.js passes dynamic route params as a promise. On static routes it still passes a
 * context object, but with `params` undefined.
 */
export interface RouteContext {
  params?: Promise<Params> | undefined;
}

export interface HandlerArgs<D> {
  request: Request;
  auth: AuthContext;
  deps: D;
  params: Record<string, string>;
}

export type ApiHandler<D> = (args: HandlerArgs<D>) => Promise<Response>;

const CORS_MAX_AGE_SECONDS = 600;
const CORS_ALLOWED_HEADERS = "authorization, content-type, idempotency-key";
const CORS_EXPOSED_HEADERS =
  "idempotent-replayed, ratelimit-limit, ratelimit-remaining, ratelimit-reset, retry-after";

export function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, init);
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json(
      { error: { code: error.code, message: error.message, details: error.details } },
      {
        status: error.status,
        ...(error instanceof RateLimitedError ? { headers: rateLimitHeaders(error.result) } : {}),
      },
    );
  }
  // Unexpected errors are logged server-side with detail and returned without it.
  console.error("[api] unhandled error", error);
  return json(
    { error: { code: "internal_error", message: "Something went wrong." } },
    { status: 500 },
  );
}

function withHeaders(
  response: Response,
  origin: string | null,
  limit: RateLimitResult | null,
): Response {
  if (!origin && !limit) return response;
  const headers = new Headers(response.headers);
  if (limit) for (const [name, value] of rateLimitHeaders(limit)) headers.set(name, value);
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-expose-headers", CORS_EXPOSED_HEADERS);
    headers.append("vary", "Origin");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function resolveParams(context: RouteContext | undefined): Promise<Record<string, string>> {
  const raw = (await context?.params) ?? {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/** The bucket an authenticated request counts against for its endpoint's rule. */
function ruleBucket(rule: RateLimitRule, auth: AuthContext, address: string, videoId?: string) {
  if (rule.by === "client") return `${rule.name}:${auth.projectId}:${address}`;
  const credential = auth.keyId ?? `upload:${videoId ?? "?"}`;
  return `${rule.name}:${credential}`;
}

/**
 * Wraps a route handler with rate limits, authentication, origin checks, CORS and the error
 * envelope. CORS headers are only added once the credential has been verified for that origin,
 * so a disallowed site's browser cannot read any response.
 *
 * Rate limits run twice: a per-address budget for the whole API before authentication (so
 * floods of bad keys cost one cheap write each), then the endpoint's own rule.
 */
export function apiRoute<D extends AuthDeps>(
  options: ApiRouteOptions,
  handler: ApiHandler<D>,
  deps: () => D,
) {
  return async (request: Request, context?: RouteContext): Promise<Response> => {
    try {
      const params = await resolveParams(context);
      const resolved = deps();
      const videoId = options.uploadTokenParam ? params[options.uploadTokenParam] : undefined;
      const limiter = resolved.rateLimiter;
      const address = clientAddress(request);
      if (limiter) await enforce(limiter, `${CLIENT_RULE.name}:${address}`, CLIENT_RULE);
      const auth = await authenticateRequest(
        request,
        { allow: options.allow, videoId, allowQueryKey: options.allowQueryKey },
        resolved,
      );
      const limit = limiter
        ? await enforce(
            limiter,
            ruleBucket(options.rateLimit, auth, address, videoId),
            options.rateLimit,
          )
        : null;
      return withHeaders(
        await handler({ request, auth, deps: resolved, params }),
        auth.origin,
        limit,
      );
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/**
 * Preflight cannot carry the credential, so it reveals nothing: it only says which methods
 * and headers are acceptable. The real request is still origin-checked.
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

/** Parses a JSON body, turning malformed input into a 400 instead of a 500. */
export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("invalid_request", "Request body is not valid JSON.");
  }
}
