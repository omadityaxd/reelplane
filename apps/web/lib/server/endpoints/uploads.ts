import { json, readJson } from "../api-route.ts";
import { endpoint } from "../endpoint.ts";
import { withIdempotency } from "../idempotency.ts";
import { RULES } from "../rate-limit.ts";
import {
  completeUploadSchema,
  createUploadSchema,
  parseBody,
  signPartsSchema,
} from "../uploads/schemas.ts";
import {
  abortUploadSession,
  completeUploadSession,
  createUploadSession,
  signUploadParts,
} from "../uploads/service.ts";

/**
 * POST /v1/uploads — start a direct upload (secret key; call it from your server).
 * Returns an upload token for the browser. Send `Idempotency-Key` to make retries safe.
 */
export const createUpload = endpoint(
  { allow: ["secret"], rateLimit: RULES.createUpload },
  async ({ request, auth, deps }) => {
    const body = await readJson(request);
    return withIdempotency(
      { pool: deps.pool, projectId: auth.projectId, operation: "uploads.create", request, body },
      async () => {
        const input = parseBody(createUploadSchema, body);
        return {
          status: 201,
          body: { data: await createUploadSession(deps, auth.projectId, input) },
        };
      },
    );
  },
);

/**
 * POST /v1/uploads/:id/parts — presigned URLs for parts still to upload, plus the parts
 * storage already has. Call again to resume after a dropped connection.
 */
export const signParts = endpoint(
  { allow: ["secret", "upload_token"], uploadTokenParam: "id", rateLimit: RULES.uploadParts },
  async ({ request, auth, deps, params }) => {
    const input = parseBody(signPartsSchema, await readJson(request));
    const data = await signUploadParts(deps, auth.projectId, params.id ?? "", input.partNumbers);
    return json({ data });
  },
);

/**
 * POST /v1/uploads/:id/complete — assemble, verify and queue the video for processing.
 * Naturally idempotent: calling it again returns the already-queued video.
 */
export const completeUpload = endpoint(
  { allow: ["secret", "upload_token"], uploadTokenParam: "id", rateLimit: RULES.finishUpload },
  async ({ request, auth, deps, params }) => {
    const input = parseBody(completeUploadSchema, await readJson(request));
    return json({
      data: await completeUploadSession(deps, auth.projectId, params.id ?? "", input),
    });
  },
);

/** DELETE /v1/uploads/:id — cancel an in-progress upload and free its stored parts. */
export const abortUpload = endpoint(
  { allow: ["secret", "upload_token"], uploadTokenParam: "id", rateLimit: RULES.finishUpload },
  async ({ auth, deps, params }) =>
    json({ data: await abortUploadSession(deps, auth.projectId, params.id ?? "") }),
);
