import {
  encodeKeyPath,
  type ObjectInfo,
  type ObjectStorage,
  type PutOptions,
  StorageError,
  type UploadedPart,
} from "./types.ts";

interface StoredObject {
  body: Uint8Array;
  contentType?: string | undefined;
}

interface PendingUpload {
  key: string;
  contentType: string;
  parts: Map<number, Uint8Array>;
}

const encoder = new TextEncoder();

/**
 * In-memory implementation for unit tests. It behaves like S3 for the parts the
 * application relies on, and exposes `receivePart` to simulate a browser part upload.
 */
export class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, StoredObject>();
  private readonly uploads = new Map<string, PendingUpload>();
  private uploadCounter = 0;

  constructor(private readonly baseUrl = "http://storage.test/bucket") {}

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    this.uploadCounter += 1;
    const uploadId = `upload-${this.uploadCounter}`;
    this.uploads.set(uploadId, { key, contentType, parts: new Map() });
    return uploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    contentLength: number,
    expiresInSeconds: number,
  ): Promise<string> {
    this.requireUpload(key, uploadId, "presignUploadPart");
    const query = new URLSearchParams({
      uploadId,
      partNumber: String(partNumber),
      contentLength: String(contentLength),
      expires: String(expiresInSeconds),
    });
    return `${this.baseUrl}/${encodeKeyPath(key)}?${query}`;
  }

  /** Test helper: what the browser's PUT to a presigned part URL would do. */
  receivePart(key: string, uploadId: string, partNumber: number, body: Uint8Array): string {
    this.requireUpload(key, uploadId, "receivePart").parts.set(partNumber, body);
    return etagFor(body);
  }

  /**
   * Test helper: performs a PUT against a URL from `presignUploadPart`, enforcing the signed
   * length like real storage does. Returns the HTTP status and ETag S3 would send back.
   */
  handlePresignedPut(url: string, body: Uint8Array): { status: number; etag: string | null } {
    const parsed = new URL(url);
    const key = decodeURIComponent(
      parsed.pathname.slice(new URL(this.baseUrl).pathname.length + 1),
    );
    const uploadId = parsed.searchParams.get("uploadId") ?? "";
    const partNumber = Number(parsed.searchParams.get("partNumber"));
    if (Number(parsed.searchParams.get("contentLength")) !== body.byteLength) {
      return { status: 403, etag: null };
    }
    if (!this.uploads.has(uploadId)) return { status: 404, etag: null };
    return { status: 200, etag: this.receivePart(key, uploadId, partNumber, body) };
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const upload = this.requireUpload(key, uploadId, "listParts");
    return [...upload.parts.entries()]
      .map(([partNumber, body]) => ({ partNumber, etag: etagFor(body), size: body.byteLength }))
      .sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    const upload = this.requireUpload(key, uploadId, "completeMultipartUpload");
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const chunks = ordered.map((part) => {
      const body = upload.parts.get(part.partNumber);
      if (!body || etagFor(body) !== part.etag) {
        throw new StorageError(
          `part ${part.partNumber} missing or ETag mismatch`,
          "completeMultipartUpload",
        );
      }
      return body;
    });
    this.objects.set(key, { body: concat(chunks), contentType: upload.contentType });
    this.uploads.delete(uploadId);
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    this.requireUpload(key, uploadId, "abortMultipartUpload");
    this.uploads.delete(uploadId);
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return `${this.baseUrl}/${encodeKeyPath(key)}?expires=${expiresInSeconds}`;
  }

  publicUrl(key: string): string {
    return `${this.baseUrl}/${encodeKeyPath(key)}`;
  }

  async putObject(key: string, body: Uint8Array | string, options: PutOptions = {}): Promise<void> {
    const bytes = typeof body === "string" ? encoder.encode(body) : body;
    this.objects.set(key, { body: bytes, contentType: options.contentType });
  }

  async getObject(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.body ?? null;
  }

  async getObjectRange(
    key: string,
    start: number,
    endInclusive: number,
  ): Promise<Uint8Array | null> {
    return this.objects.get(key)?.body.slice(start, endInclusive + 1) ?? null;
  }

  async headObject(key: string): Promise<ObjectInfo | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      size: object.body.byteLength,
      contentType: object.contentType,
      etag: etagFor(object.body),
    };
  }

  async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    const object = this.objects.get(sourceKey);
    if (!object) throw new StorageError(`no such key: ${sourceKey}`, "copyObject");
    this.objects.set(destinationKey, { ...object });
  }

  async listObjects(prefix: string): Promise<ObjectInfo[]> {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, object]) => ({ key, size: object.body.byteLength, etag: etagFor(object.body) }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix) throw new StorageError("refusing to delete an empty prefix", "deletePrefix");
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    for (const key of keys) this.objects.delete(key);
    return keys.length;
  }

  private requireUpload(key: string, uploadId: string, operation: string): PendingUpload {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) {
      throw new StorageError(`no such upload: ${uploadId}`, operation);
    }
    return upload;
  }
}

/** Deterministic stand-in for an S3 ETag (FNV-1a over the bytes). */
function etagFor(body: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of body) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `"${(hash >>> 0).toString(16).padStart(8, "0")}-${body.byteLength}"`;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
