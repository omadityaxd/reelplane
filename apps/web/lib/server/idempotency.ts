import { createHash } from "node:crypto";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  type IdempotencyScope,
  type Pool,
  releaseIdempotencyKey,
} from "@reelplane/db";
import { ApiError } from "./errors.ts";

export interface IdempotentResult {
  status: number;
  body: unknown;
}

const MAX_KEY_LENGTH = 255;
const REPLAY_HEADER = "idempotent-replayed";

/**
 * Runs `operation` at most once per `Idempotency-Key` header. A retry with the same key and
 * body gets the stored response (marked `Idempotent-Replayed: true`); the same key with a
 * different body is rejected. Without the header, the operation simply runs.
 *
 * 4xx outcomes are stored like successes (retrying a bad request will not fix it). 5xx and
 * unexpected errors release the key so the client can retry.
 */
export async function withIdempotency(
  input: { pool: Pool; projectId: string; operation: string; request: Request; body: unknown },
  operation: () => Promise<IdempotentResult>,
): Promise<Response> {
  const key = input.request.headers.get("idempotency-key");
  if (!key) {
    const result = await operation();
    return Response.json(result.body, { status: result.status });
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new ApiError(
      "invalid_request",
      `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters.`,
    );
  }

  const scope: IdempotencyScope = { projectId: input.projectId, operation: input.operation, key };
  const requestHash = createHash("sha256")
    .update(JSON.stringify(input.body ?? null))
    .digest("hex");
  const claim = await claimIdempotencyKey(input.pool, scope, requestHash);

  switch (claim.state) {
    case "replay":
      return Response.json(claim.response, {
        status: claim.statusCode,
        headers: { [REPLAY_HEADER]: "true" },
      });
    case "in_progress":
      throw new ApiError("conflict", "A request with this Idempotency-Key is still in progress.");
    case "mismatch":
      throw new ApiError(
        "conflict",
        "This Idempotency-Key was already used with a different request body.",
      );
    case "claimed":
      break;
  }

  try {
    const result = await operation();
    await completeIdempotencyKey(input.pool, scope, result.status, result.body);
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) {
      const body = { error: { code: error.code, message: error.message, details: error.details } };
      await completeIdempotencyKey(input.pool, scope, error.status, body);
    } else {
      await releaseIdempotencyKey(input.pool, scope).catch(() => undefined);
    }
    throw error;
  }
}
