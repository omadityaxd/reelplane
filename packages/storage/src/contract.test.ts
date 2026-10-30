import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadStorageConfig } from "./config.ts";
import { createStorage } from "./index.ts";
import { MemoryObjectStorage } from "./memory.ts";
import type { ObjectStorage, UploadedPart } from "./types.ts";

/** S3 requires every part except the last to be at least 5 MiB. */
const MIN_PART_SIZE = 5 * 1024 * 1024;

type PartUploader = (
  storage: ObjectStorage,
  key: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
) => Promise<string>;

/** Real backends: PUT the bytes to the presigned URL, exactly as a browser would. */
const uploadViaPresignedUrl: PartUploader = async (storage, key, uploadId, partNumber, body) => {
  const url = await storage.presignUploadPart(key, uploadId, partNumber, 300);
  const response = await fetch(url, { method: "PUT", body });
  expect(response.status).toBe(200);
  const etag = response.headers.get("etag");
  if (!etag) throw new Error("storage did not expose the part ETag");
  return etag;
};

const uploadToMemory: PartUploader = async (storage, key, uploadId, partNumber, body) =>
  (storage as MemoryObjectStorage).receivePart(key, uploadId, partNumber, body);

function filled(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + seed) % 251;
  return bytes;
}

function runContract(name: string, makeStorage: () => ObjectStorage, uploadPart: PartUploader) {
  describe(`ObjectStorage contract: ${name}`, () => {
    const storage = makeStorage();
    const root = `test/${randomUUID()}`;

    it("puts, heads, gets and deletes an object", async () => {
      const key = `${root}/hello.txt`;
      await storage.putObject(key, "hello", { contentType: "text/plain" });

      const info = await storage.headObject(key);
      expect(info?.size).toBe(5);
      expect(new TextDecoder().decode((await storage.getObject(key)) ?? new Uint8Array())).toBe(
        "hello",
      );

      await storage.deleteObject(key);
      expect(await storage.headObject(key)).toBeNull();
      expect(await storage.getObject(key)).toBeNull();
    });

    it("resumes a multipart upload from the parts storage already has", async () => {
      const key = `${root}/video.mp4`;
      const first = filled(MIN_PART_SIZE, 1);
      const second = filled(1024, 2);
      const uploadId = await storage.createMultipartUpload(key, "video/mp4");

      await uploadPart(storage, key, uploadId, 1, first);
      // The client "loses its connection" here; on resume it asks storage what arrived.
      const received = await storage.listParts(key, uploadId);
      expect(received.map((part) => part.partNumber)).toEqual([1]);
      expect(received[0]?.size).toBe(MIN_PART_SIZE);

      const etag = await uploadPart(storage, key, uploadId, 2, second);
      const parts: UploadedPart[] = [...received, { partNumber: 2, etag, size: second.byteLength }];
      await storage.completeMultipartUpload(key, uploadId, parts);

      const info = await storage.headObject(key);
      expect(info?.size).toBe(MIN_PART_SIZE + 1024);
      expect(info?.contentType).toBe("video/mp4");
    });

    it("aborts a multipart upload", async () => {
      const key = `${root}/aborted.mp4`;
      const uploadId = await storage.createMultipartUpload(key, "video/mp4");
      await storage.abortMultipartUpload(key, uploadId);
      await expect(storage.listParts(key, uploadId)).rejects.toThrow();
    });

    it("copies objects and deletes a whole prefix (temp-prefix publish)", async () => {
      await storage.putObject(`${root}/tmp/a.m4s`, "a");
      await storage.putObject(`${root}/tmp/b.m4s`, "b");
      await storage.copyObject(`${root}/tmp/a.m4s`, `${root}/final/a.m4s`);

      expect((await storage.listObjects(`${root}/tmp/`)).map((o) => o.key)).toEqual([
        `${root}/tmp/a.m4s`,
        `${root}/tmp/b.m4s`,
      ]);
      expect(await storage.deletePrefix(`${root}/tmp/`)).toBe(2);
      expect(await storage.listObjects(`${root}/tmp/`)).toEqual([]);
      expect(await storage.headObject(`${root}/final/a.m4s`)).not.toBeNull();
      await storage.deletePrefix(`${root}/`);
    });

    it("refuses to delete an empty prefix", async () => {
      await expect(storage.deletePrefix("")).rejects.toThrow(/empty prefix/);
    });

    it("builds URL-encoded public URLs", () => {
      expect(storage.publicUrl("videos/a b/master.m3u8")).toMatch(/\/videos\/a%20b\/master\.m3u8$/);
    });
  });
}

runContract("memory", () => new MemoryObjectStorage(), uploadToMemory);

// Runs against the real configured backend (local RustFS by default) with `STORAGE_INTEGRATION=1`.
if (process.env.STORAGE_INTEGRATION === "1") {
  runContract(`s3 (${loadStorageConfig().provider})`, () => createStorage(), uploadViaPresignedUrl);
}
