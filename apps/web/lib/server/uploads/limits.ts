const MIB = 1024 * 1024;

export const SUPPORTED_CONTENT_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
] as const;
export type SupportedContentType = (typeof SUPPORTED_CONTENT_TYPES)[number];

export interface UploadLimits {
  maxBytes: number;
  maxDurationMs: number;
  /** 8 MiB: big enough for S3's 5 MiB minimum, small enough to lose little on a dropped part. */
  partSizeBytes: number;
  partUrlTtlSeconds: number;
  sessionTtlSeconds: number;
  maxPartsPerRequest: number;
}

/**
 * UPLOAD_MAX_BYTES lowers the 100 MB cap when the storage provider has a smaller per-file limit
 * (Supabase's free plan: 50 MB).
 */
function maxUploadBytes(): number {
  const value = Number(process.env.UPLOAD_MAX_BYTES ?? 100 * MIB);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100 * MIB) : 100 * MIB;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxBytes: maxUploadBytes(),
  maxDurationMs: 60_000,
  partSizeBytes: 8 * MIB,
  partUrlTtlSeconds: 15 * 60,
  sessionTtlSeconds: 24 * 60 * 60,
  maxPartsPerRequest: 100,
};

/** S3 allows at most 10,000 parts per upload. */
const MAX_S3_PARTS = 10_000;

export function partCount(sizeBytes: number, partSizeBytes: number): number {
  const count = Math.ceil(sizeBytes / partSizeBytes);
  if (count > MAX_S3_PARTS) throw new RangeError("file needs more than 10,000 parts");
  return count;
}

/** Every part is `partSize` bytes except the last, which holds the remainder. */
export function partLength(partNumber: number, sizeBytes: number, partSizeBytes: number): number {
  const count = partCount(sizeBytes, partSizeBytes);
  if (partNumber < 1 || partNumber > count) throw new RangeError(`no part ${partNumber}`);
  return partNumber < count ? partSizeBytes : sizeBytes - partSizeBytes * (count - 1);
}
