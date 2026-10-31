/**
 * The single storage abstraction used by the API and (mirrored in Go) by the worker.
 * Every provider we support speaks the S3 API, so swapping B2 / R2 / RustFS / AWS
 * is purely a configuration change.
 */

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface ObjectInfo {
  key: string;
  size: number;
  contentType?: string | undefined;
  etag?: string | undefined;
}

export interface PutOptions {
  contentType?: string;
  cacheControl?: string;
}

export interface ObjectStorage {
  /** Starts a multipart upload and returns its upload id. */
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  /**
   * Presigns a PUT for one part; the browser uploads the bytes directly. The exact
   * `contentLength` is part of the signature, so storage rejects a part of any other size:
   * a client cannot declare 1 MB and then upload 5 GB.
   */
  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    contentLength: number,
    expiresInSeconds: number,
  ): Promise<string>;
  /** Parts the storage has already received: the source of truth for resuming. */
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  /** Public (CDN) URL for published, immutable assets such as HLS segments. */
  publicUrl(key: string): string;

  putObject(key: string, body: Uint8Array | string, options?: PutOptions): Promise<void>;
  getObject(key: string): Promise<Uint8Array | null>;
  /** Reads bytes [start, endInclusive] (e.g. a file header for type sniffing). */
  getObjectRange(key: string, start: number, endInclusive: number): Promise<Uint8Array | null>;
  headObject(key: string): Promise<ObjectInfo | null>;
  copyObject(sourceKey: string, destinationKey: string): Promise<void>;
  listObjects(prefix: string): Promise<ObjectInfo[]>;
  deleteObject(key: string): Promise<void>;
  /** Deletes every object under a prefix; returns how many were removed. */
  deletePrefix(prefix: string): Promise<number>;
}

/** URL-encodes each segment of an object key while keeping the `/` separators. */
export function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export class StorageError extends Error {
  override readonly name = "StorageError";
  constructor(
    message: string,
    readonly operation: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
