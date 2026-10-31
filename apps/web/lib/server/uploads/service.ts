import { randomUUID } from "node:crypto";
import {
  endUpload,
  getVideo,
  hashApiKey,
  insertUploadingVideo,
  queueUploadedVideo,
  type Video,
} from "@reelplane/db";
import type { UploadedPart } from "@reelplane/storage";
import type { AppDeps } from "../deps.ts";
import { ApiError } from "../errors.ts";
import { type PublicVideo, serializeVideo } from "../videos/serialize.ts";
import { partCount, partLength, type SupportedContentType } from "./limits.ts";
import type { CompleteUploadInput, CreateUploadInput } from "./schemas.ts";
import { detectContainer, matchesDeclaredType, SNIFF_BYTES } from "./sniff.ts";
import { generateUploadToken } from "./token.ts";

const MIB = 1024 * 1024;

export interface UploadSession {
  video: PublicVideo;
  upload: {
    videoId: string;
    token: string;
    partSize: number;
    partCount: number;
    expiresAt: string;
  };
}

export interface SignedParts {
  partSize: number;
  partCount: number;
  /** Parts storage already holds: the client skips these when resuming. */
  receivedParts: { partNumber: number; size: number; etag: string }[];
  urls: { partNumber: number; size: number; url: string }[];
  urlsExpireAt: string;
}

function validateLimits(input: CreateUploadInput, deps: AppDeps): void {
  const { maxBytes, maxDurationMs } = deps.limits;
  if (input.sizeBytes > maxBytes) {
    throw new ApiError("invalid_request", `File is too large: the limit is ${maxBytes / MIB} MB.`);
  }
  if (input.durationMs !== undefined && input.durationMs > maxDurationMs) {
    throw new ApiError(
      "invalid_request",
      `Video is too long: the limit is ${maxDurationMs / 1000} seconds.`,
    );
  }
}

/**
 * Starts a direct-to-storage upload: creates the multipart upload, the `uploading` video row
 * and a one-video upload token. No video bytes ever pass through this server.
 */
export async function createUploadSession(
  deps: AppDeps,
  projectId: string,
  input: CreateUploadInput,
): Promise<UploadSession> {
  validateLimits(input, deps);
  const videoId = randomUUID();
  const sourceKey = `originals/${projectId}/${videoId}/source`;
  const token = generateUploadToken();
  const uploadId = await deps.storage.createMultipartUpload(sourceKey, input.contentType);

  let video: Video;
  try {
    video = await insertUploadingVideo(deps.pool, {
      id: videoId,
      projectId,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      sourceKey,
      uploadId,
      uploadTokenHash: hashApiKey(token, deps.pepper),
      uploadTtlSeconds: deps.limits.sessionTtlSeconds,
      partSizeBytes: deps.limits.partSizeBytes,
      originalFilename: input.filename,
      declaredDurationMs: input.durationMs,
      title: input.title,
      creatorId: input.creatorId,
    });
  } catch (error) {
    // Don't leave an orphaned multipart upload accruing storage.
    await deps.storage.abortMultipartUpload(sourceKey, uploadId).catch(() => undefined);
    throw error;
  }

  return {
    video: serializeVideo(video, deps.storage),
    upload: {
      videoId,
      token,
      partSize: deps.limits.partSizeBytes,
      partCount: partCount(input.sizeBytes, deps.limits.partSizeBytes),
      expiresAt: video.uploadExpiresAt?.toISOString() ?? "",
    },
  };
}

async function requireUploadingVideo(deps: AppDeps, projectId: string, videoId: string) {
  const video = await getVideo(deps.pool, projectId, videoId);
  if (!video) throw new ApiError("not_found", "Upload not found.");
  if (video.status !== "uploading" || !video.uploadId || !video.partSizeBytes) {
    throw new ApiError("conflict", `Upload is no longer in progress (status: ${video.status}).`);
  }
  return { video, uploadId: video.uploadId, partSize: video.partSizeBytes };
}

/**
 * Presigns part URLs (each bound to its exact byte length) and reports which parts storage
 * already has. Calling this again after a dropped connection is how a client resumes.
 */
export async function signUploadParts(
  deps: AppDeps,
  projectId: string,
  videoId: string,
  requested: number[] | undefined,
): Promise<SignedParts> {
  const { video, uploadId, partSize } = await requireUploadingVideo(deps, projectId, videoId);
  const total = partCount(video.sizeBytes, partSize);
  const received = await deps.storage.listParts(video.sourceKey, uploadId);
  const receivedNumbers = new Set(received.map((part) => part.partNumber));

  const wanted =
    requested ??
    Array.from({ length: total }, (_, index) => index + 1).filter((n) => !receivedNumbers.has(n));
  const partNumbers = [...new Set(wanted)].slice(0, deps.limits.maxPartsPerRequest);
  const invalid = partNumbers.find((n) => n > total);
  if (invalid !== undefined) {
    throw new ApiError(
      "invalid_request",
      `Part ${invalid} does not exist; this upload has ${total} parts.`,
    );
  }

  const urls = await Promise.all(
    partNumbers.map(async (partNumber) => {
      const size = partLength(partNumber, video.sizeBytes, partSize);
      const url = await deps.storage.presignUploadPart(
        video.sourceKey,
        uploadId,
        partNumber,
        size,
        deps.limits.partUrlTtlSeconds,
      );
      return { partNumber, size, url };
    }),
  );

  return {
    partSize,
    partCount: total,
    receivedParts: received.map(({ partNumber, size, etag }) => ({ partNumber, size, etag })),
    urls,
    urlsExpireAt: new Date(Date.now() + deps.limits.partUrlTtlSeconds * 1000).toISOString(),
  };
}

/** Storage is the source of truth: every part must be there with its exact expected size. */
function verifyParts(
  video: Video,
  partSize: number,
  stored: UploadedPart[],
  clientParts: CompleteUploadInput["parts"],
): void {
  const total = partCount(video.sizeBytes, partSize);
  const byNumber = new Map(stored.map((part) => [part.partNumber, part]));
  const missing: number[] = [];
  for (let n = 1; n <= total; n += 1) {
    const part = byNumber.get(n);
    if (!part || part.size !== partLength(n, video.sizeBytes, partSize)) missing.push(n);
  }
  if (missing.length > 0) {
    throw new ApiError("conflict", "Upload is incomplete: some parts are missing.", {
      missingParts: missing.slice(0, 100),
    });
  }
  for (const part of clientParts ?? []) {
    if (byNumber.get(part.partNumber)?.etag !== part.etag) {
      throw new ApiError(
        "invalid_request",
        `Part ${part.partNumber} does not match what storage received.`,
      );
    }
  }
}

/**
 * Assembles the parts. Tolerates a replay after an earlier attempt already assembled them but
 * crashed before the database update: then the multipart upload is gone and the object exists.
 */
async function assemble(
  deps: AppDeps,
  video: Video,
  uploadId: string,
  partSize: number,
  clientParts: CompleteUploadInput["parts"],
): Promise<void> {
  let stored: UploadedPart[];
  try {
    stored = await deps.storage.listParts(video.sourceKey, uploadId);
  } catch (error) {
    const object = await deps.storage.headObject(video.sourceKey);
    if (object?.size === video.sizeBytes) return;
    throw error;
  }
  verifyParts(video, partSize, stored, clientParts);
  try {
    await deps.storage.completeMultipartUpload(video.sourceKey, uploadId, stored);
  } catch (error) {
    // A concurrent complete may have assembled it between our listParts and this call.
    const object = await deps.storage.headObject(video.sourceKey);
    if (object?.size !== video.sizeBytes) throw error;
  }
}

async function rejectNonVideo(deps: AppDeps, video: Video): Promise<never> {
  await deps.storage.deleteObject(video.sourceKey).catch(() => undefined);
  await endUpload(deps.pool, video.projectId, video.id, "failed", "unsupported_file_type");
  throw new ApiError("invalid_request", "The uploaded file is not a supported video.");
}

/**
 * Finishes an upload: verifies every part, assembles the object, checks magic bytes, then
 * moves the video to `queued` and creates its job in one transaction. Safe to call any
 * number of times: once queued, it just returns the video.
 */
export async function completeUploadSession(
  deps: AppDeps,
  projectId: string,
  videoId: string,
  input: CompleteUploadInput,
): Promise<PublicVideo> {
  const video = await getVideo(deps.pool, projectId, videoId);
  if (!video) throw new ApiError("not_found", "Upload not found.");
  if (video.status !== "uploading") return serializeVideo(video, deps.storage);
  if (!video.partSizeBytes) throw new ApiError("conflict", "Upload is missing its session.");

  if (video.uploadId) await assemble(deps, video, video.uploadId, video.partSizeBytes, input.parts);

  const header = await deps.storage.getObjectRange(video.sourceKey, 0, SNIFF_BYTES - 1);
  const container = header ? detectContainer(header) : null;
  if (!container || !matchesDeclaredType(container, video.contentType as SupportedContentType)) {
    return rejectNonVideo(deps, video);
  }

  const result = await queueUploadedVideo(deps.pool, projectId, videoId);
  if (result.outcome === "not_found") throw new ApiError("not_found", "Upload not found.");
  return serializeVideo(result.video, deps.storage);
}

/** Cancels an in-progress upload and frees the parts storage is holding. */
export async function abortUploadSession(
  deps: AppDeps,
  projectId: string,
  videoId: string,
): Promise<PublicVideo> {
  const video = await getVideo(deps.pool, projectId, videoId);
  if (!video) throw new ApiError("not_found", "Upload not found.");
  if (video.status !== "uploading") {
    throw new ApiError("conflict", `Upload is no longer in progress (status: ${video.status}).`);
  }
  if (video.uploadId) {
    await deps.storage.abortMultipartUpload(video.sourceKey, video.uploadId).catch(() => undefined);
  }
  const ended = await endUpload(deps.pool, projectId, videoId, "deleted", "upload_aborted");
  return serializeVideo(ended ?? video, deps.storage);
}
