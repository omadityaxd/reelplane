import {
  type ApiKeyKind,
  type AuthenticatedKey,
  authenticateApiKey,
  type Pool,
} from "@reelplane/db";
import { ApiError } from "./errors.ts";

export interface AuthContext {
  projectId: string;
  keyId: string;
  keyKind: ApiKeyKind;
  /** The browser origin, when the request came from an allowed one. */
  origin: string | null;
}

export interface AuthOptions {
  /** Which key kinds may call this route. Writes are secret-only. */
  allow: readonly ApiKeyKind[];
}

export interface AuthDeps {
  pool: Pool;
  pepper: string;
}

const BEARER = /^Bearer\s+(\S+)$/i;

export function extractApiKey(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  return BEARER.exec(header.trim())?.[1] ?? null;
}

/**
 * Publishable keys are public by design, so the guard against another site embedding them is
 * the Origin header (which browsers set and page scripts cannot forge). Requests without an
 * Origin (server-to-server, curl) are allowed: a publishable key only grants read access to
 * public feed data, which anyone could fetch through an allowed site anyway.
 */
function checkOrigin(key: AuthenticatedKey, origin: string | null): void {
  if (key.kind === "secret") {
    // A secret key seen from a browser has leaked into client code: refuse loudly.
    if (origin) {
      throw new ApiError(
        "forbidden",
        "Secret keys must only be used server-side. Use a publishable key in the browser.",
      );
    }
    return;
  }
  if (origin && !key.allowedOrigins.includes(origin)) {
    throw new ApiError("forbidden", `Origin ${origin} is not allowed for this publishable key.`);
  }
}

export async function authenticateRequest(
  request: Request,
  options: AuthOptions,
  deps: AuthDeps,
): Promise<AuthContext> {
  const rawKey = extractApiKey(request);
  if (!rawKey) {
    throw new ApiError("unauthorized", "Missing API key. Send `Authorization: Bearer <key>`.");
  }
  const key = await authenticateApiKey(deps.pool, rawKey, deps.pepper);
  if (!key) {
    throw new ApiError("unauthorized", "Invalid, revoked or expired API key.");
  }
  const origin = request.headers.get("origin");
  checkOrigin(key, origin);
  if (!options.allow.includes(key.kind)) {
    throw new ApiError("forbidden", `This endpoint requires a ${options.allow.join(" or ")} key.`);
  }
  return { projectId: key.projectId, keyId: key.keyId, keyKind: key.kind, origin };
}
