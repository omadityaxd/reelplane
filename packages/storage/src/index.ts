import { loadStorageConfig, type StorageConfig } from "./config.ts";
import { createS3Client, S3ObjectStorage } from "./s3.ts";
import type { ObjectStorage } from "./types.ts";

export {
  LOCAL_STORAGE_DEFAULTS,
  loadStorageConfig,
  type StorageConfig,
  type StorageProvider,
} from "./config.ts";
export { MemoryObjectStorage } from "./memory.ts";
export {
  createS3Client,
  type EnsureBucketResult,
  ensureBucket,
  PUBLIC_MEDIA_PREFIX,
  S3ObjectStorage,
} from "./s3.ts";
export type { ObjectInfo, ObjectStorage, PutOptions, UploadedPart } from "./types.ts";
export { StorageError } from "./types.ts";

/** Builds the configured storage backend from environment variables. */
export function createStorage(config: StorageConfig = loadStorageConfig()): ObjectStorage {
  return new S3ObjectStorage(createS3Client(config), config);
}
