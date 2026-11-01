import {
  type ApiKeyKind,
  authenticateApiKey,
  authenticateUploadToken,
  hashApiKey,
  type Pool,
} from "@reelplane/db";
import { ApiError } from "./errors.ts";
import { isUploadToken } from "./uploads/token.ts";

/** Which credential authenticated the request. */
export type Credential = ApiKeyKind | "upload_token";

export interface AuthContext {
  projectId: string;
  credential: Credential;
  /** API key id; null for upload tokens. */
  keyId: string | null;
  /** The browser origin, when the request came from an allowed one. */
  origin: string | null;
}

export interface AuthOptions {
  /** Which credentials may call this route. Writes are secret-only. */
  allow: readonly Credential[];
  /** For upload-token routes: the video the token must belong to. */
  videoId?: string | undefined;
  /**
   * Also accept a publishable key as `?key=` (secret keys are refused there: URLs end up in
   * logs). Needed for metrics flushed on page unload, which cannot send custom headers
   * without a CORS preflight.
   */
  allowQueryKey?: boolean | undefined;
}

export interface AuthDeps {
  pool: Pool;
  pepper: string;
}

const BEARER = /^Bearer\s+(\S+)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  return BEARER.exec(header.trim())?.[1] ?? null;
}

/**
 * Browser-usable credentials (publishable keys, upload tokens) are only honoured from the
 * project's allowed origins. Requests without an Origin (server-to-server, curl) are allowed:
 * the guard exists to stop *other websites* from using the credential in their visitors' browsers.
 */
function checkBrowserOrigin(allowedOrigins: string[], origin: string | null, what: string): void {
  if (origin && !allowedOrigins.includes(origin)) {
    throw new ApiError("forbidden", `Origin ${origin} is not allowed for this ${what}.`);
  }
}

async function authenticateWithUploadToken(
  token: string,
  options: AuthOptions,
  deps: AuthDeps,
  origin: string | null,
): Promise<AuthContext> {
  if (!options.allow.includes("upload_token") || !options.videoId) {
    throw new ApiError("forbidden", "Upload tokens can only be used for their own upload.");
  }
  if (!UUID.test(options.videoId)) throw new ApiError("not_found", "Upload not found.");
  const match = await authenticateUploadToken(
    deps.pool,
    options.videoId,
    hashApiKey(token, deps.pepper),
  );
  if (!match) throw new ApiError("unauthorized", "Invalid or expired upload token.");
  checkBrowserOrigin(match.allowedOrigins, origin, "upload");
  return { projectId: match.projectId, credential: "upload_token", keyId: null, origin };
}

export async function authenticateRequest(
  request: Request,
  options: AuthOptions,
  deps: AuthDeps,
): Promise<AuthContext> {
  const fromHeader = extractBearer(request);
  const credential =
    fromHeader ?? (options.allowQueryKey ? new URL(request.url).searchParams.get("key") : null);
  if (!credential) {
    throw new ApiError("unauthorized", "Missing API key. Send `Authorization: Bearer <key>`.");
  }
  const origin = request.headers.get("origin");
  if (isUploadToken(credential)) {
    return authenticateWithUploadToken(credential, options, deps, origin);
  }

  const key = await authenticateApiKey(deps.pool, credential, deps.pepper);
  if (!key) throw new ApiError("unauthorized", "Invalid, revoked or expired API key.");

  if (key.kind === "secret" && !fromHeader) {
    throw new ApiError(
      "forbidden",
      "Secret keys must be sent in the Authorization header, never in a URL.",
    );
  }
  if (key.kind === "secret" && origin) {
    // A secret key seen from a browser has leaked into client code: refuse loudly.
    throw new ApiError(
      "forbidden",
      "Secret keys must only be used server-side. Use a publishable key in the browser.",
    );
  }
  if (key.kind === "publishable") checkBrowserOrigin(key.allowedOrigins, origin, "publishable key");
  if (!options.allow.includes(key.kind)) {
    const allowed = options.allow.filter((kind) => kind !== "upload_token").join(" or ");
    throw new ApiError("forbidden", `This endpoint requires a ${allowed} key.`);
  }
  return { projectId: key.projectId, credential: key.kind, keyId: key.keyId, origin };
}
