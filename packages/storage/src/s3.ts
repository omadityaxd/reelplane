import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageConfig } from "./config.ts";
import {
  encodeKeyPath,
  type ObjectInfo,
  type ObjectStorage,
  type PutOptions,
  StorageError,
  type UploadedPart,
} from "./types.ts";

const DELETE_BATCH_SIZE = 1000;

export function createS3Client(config: StorageConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // AWS SDK v3 adds CRC checksums by default since 2025. B2, R2 and RustFS do not
    // all accept them, and they would break browser uploads to presigned part URLs.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (error.$metadata.httpStatusCode === 404 ||
      error.name === "NotFound" ||
      error.name === "NoSuchKey")
  );
}

async function wrap<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new StorageError(`${operation} failed: ${detail}`, operation, { cause: error });
  }
}

export class S3ObjectStorage implements ObjectStorage {
  readonly bucket: string;

  constructor(
    private readonly client: S3Client,
    private readonly config: StorageConfig,
  ) {
    this.bucket = config.bucket;
  }

  createMultipartUpload(key: string, contentType: string): Promise<string> {
    return wrap("createMultipartUpload", async () => {
      const result = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: contentType,
        }),
      );
      if (!result.UploadId) throw new Error("storage returned no UploadId");
      return result.UploadId;
    });
  }

  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    contentLength: number,
    expiresInSeconds: number,
  ): Promise<string> {
    return wrap("presignUploadPart", () =>
      getSignedUrl(
        this.client,
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          ContentLength: contentLength,
        }),
        // Force content-length into X-Amz-SignedHeaders instead of hoisting it away.
        { expiresIn: expiresInSeconds, signableHeaders: new Set(["content-length"]) },
      ),
    );
  }

  listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    return wrap("listParts", async () => {
      const parts: UploadedPart[] = [];
      let marker: string | undefined;
      do {
        const page = await this.client.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const part of page.Parts ?? []) {
          if (part.PartNumber && part.ETag) {
            parts.push({ partNumber: part.PartNumber, etag: part.ETag, size: part.Size ?? 0 });
          }
        }
        marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
      } while (marker);
      return parts.sort((a, b) => a.partNumber - b.partNumber);
    });
  }

  completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
    return wrap("completeMultipartUpload", async () => {
      const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: ordered.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
          },
        }),
      );
    });
  }

  abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    return wrap("abortMultipartUpload", async () => {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    });
  }

  presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return wrap("presignGet", () =>
      getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      }),
    );
  }

  publicUrl(key: string): string {
    return `${this.config.publicBaseUrl}/${encodeKeyPath(key)}`;
  }

  putObject(key: string, body: Uint8Array | string, options: PutOptions = {}): Promise<void> {
    return wrap("putObject", async () => {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          CacheControl: options.cacheControl,
        }),
      );
    });
  }

  getObject(key: string): Promise<Uint8Array | null> {
    return wrap("getObject", async () => {
      try {
        const result = await this.client.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        );
        return result.Body ? await result.Body.transformToByteArray() : new Uint8Array();
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    });
  }

  getObjectRange(key: string, start: number, endInclusive: number): Promise<Uint8Array | null> {
    return wrap("getObjectRange", async () => {
      try {
        const result = await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Range: `bytes=${start}-${endInclusive}`,
          }),
        );
        return result.Body ? await result.Body.transformToByteArray() : new Uint8Array();
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    });
  }

  headObject(key: string): Promise<ObjectInfo | null> {
    return wrap("headObject", async () => {
      try {
        const result = await this.client.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        );
        return {
          key,
          size: result.ContentLength ?? 0,
          contentType: result.ContentType,
          etag: result.ETag,
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    });
  }

  copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    return wrap("copyObject", async () => {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: destinationKey,
          CopySource: `${this.bucket}/${encodeKeyPath(sourceKey)}`,
        }),
      );
    });
  }

  listObjects(prefix: string): Promise<ObjectInfo[]> {
    return wrap("listObjects", async () => {
      const objects: ObjectInfo[] = [];
      let token: string | undefined;
      do {
        const page = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const item of page.Contents ?? []) {
          if (item.Key) objects.push({ key: item.Key, size: item.Size ?? 0, etag: item.ETag });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return objects;
    });
  }

  deleteObject(key: string): Promise<void> {
    return wrap("deleteObject", async () => {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    });
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix) throw new StorageError("refusing to delete an empty prefix", "deletePrefix");
    const objects = await this.listObjects(prefix);
    return wrap("deletePrefix", async () => {
      for (let start = 0; start < objects.length; start += DELETE_BATCH_SIZE) {
        const batch = objects.slice(start, start + DELETE_BATCH_SIZE);
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: batch.map((object) => ({ Key: object.key })), Quiet: true },
          }),
        );
      }
      return objects.length;
    });
  }
}

/** Published HLS outputs live here and are world-readable; originals stay private. */
export const PUBLIC_MEDIA_PREFIX = "media/";

export interface EnsureBucketResult {
  created: boolean;
  /** null when the public-read policy was applied, else why it could not be. */
  publicReadError: string | null;
}

/** One-off bucket administration used by `pnpm infra:init`; not part of the runtime interface. */
export async function ensureBucket(
  client: S3Client,
  bucket: string,
  allowedOrigins: string[],
): Promise<EnsureBucketResult> {
  let created = false;
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    created = true;
  }
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: allowedOrigins,
            AllowedMethods: ["GET", "HEAD", "PUT"],
            AllowedHeaders: ["*"],
            // The browser needs the part ETag to complete a multipart upload.
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );
  return { created, publicReadError: await allowPublicMediaReads(client, bucket) };
}

/**
 * Lets anyone GET objects under `media/` (players fetch segments directly). Not every
 * S3-compatible provider supports bucket policies: B2 uses a "public bucket" setting and R2 a
 * public bucket domain instead, so failure is reported, not thrown.
 */
async function allowPublicMediaReads(client: S3Client, bucket: string): Promise<string | null> {
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "PublicReadPublishedMedia",
        Effect: "Allow",
        Principal: { AWS: ["*"] },
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${bucket}/${PUBLIC_MEDIA_PREFIX}*`],
      },
    ],
  };
  try {
    await client.send(
      new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }),
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
