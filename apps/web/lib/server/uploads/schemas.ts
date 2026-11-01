import { z } from "zod";
import { ApiError } from "../errors.ts";
import { SUPPORTED_CONTENT_TYPES } from "./limits.ts";

export const createUploadSchema = z.strictObject({
  contentType: z.enum(SUPPORTED_CONTENT_TYPES),
  sizeBytes: z.number().int().positive(),
  /** Measured in the browser before upload; re-checked by ffprobe in the worker. */
  durationMs: z.number().int().nonnegative().optional(),
  filename: z.string().trim().min(1).max(255).optional(),
  title: z.string().trim().max(200).optional(),
  creatorId: z.string().trim().min(1).max(200).optional(),
  /** Free-form strings shown with the video (e.g. a credit line); at most 20 keys. */
  metadata: z
    .record(z.string().regex(/^[a-zA-Z0-9_]{1,40}$/), z.string().max(500))
    .refine((value) => Object.keys(value).length <= 20, "at most 20 metadata keys")
    .optional(),
});
export type CreateUploadInput = z.infer<typeof createUploadSchema>;

export const signPartsSchema = z.strictObject({
  partNumbers: z.array(z.number().int().positive()).max(100).optional(),
});

export const completeUploadSchema = z.strictObject({
  parts: z
    .array(
      z.strictObject({ partNumber: z.number().int().positive(), etag: z.string().min(1).max(200) }),
    )
    .max(10_000)
    .optional(),
});
export type CompleteUploadInput = z.infer<typeof completeUploadSchema>;

/** Validates with a schema; failures become a 400 listing each problem. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError(
      "invalid_request",
      "Request body is invalid.",
      result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  return result.data;
}
