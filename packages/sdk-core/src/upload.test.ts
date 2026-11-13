import { describe, expect, it } from "vitest";
import { backoffDelay } from "./backoff.ts";
import type { PartTransport } from "./transport.ts";
import { UploadError, uploadVideo } from "./upload.ts";

const PART = 4;

/**
 * A fake upload API + storage: just enough of the server contract for the client's retry,
 * resume and progress logic. Server-side behaviour is tested for real in apps/web.
 */
function fakeServer(size: number, alreadyStored: number[] = [], completeStatus = "queued") {
  const partCount = Math.ceil(size / PART);
  const stored = new Map<number, number>(
    alreadyStored.map((n) => [n, Math.min(PART, size - (n - 1) * PART)]),
  );
  const calls: string[] = [];
  let completedWith: unknown = null;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      partNumbers?: number[];
      parts?: unknown;
    };
    calls.push(path.split("/").at(-1) ?? "");
    if (path.endsWith("/parts")) {
      const wanted =
        body.partNumbers ??
        Array.from({ length: partCount }, (_, i) => i + 1).filter((n) => !stored.has(n));
      return Response.json({
        data: {
          partSize: PART,
          partCount,
          receivedParts: [...stored].map(([partNumber, s]) => ({
            partNumber,
            size: s,
            etag: `"e${partNumber}"`,
          })),
          urls: wanted.map((partNumber) => ({
            partNumber,
            size: PART,
            url: `https://s3.test/p?partNumber=${partNumber}`,
          })),
        },
      });
    }
    completedWith = body.parts;
    return Response.json({ data: { id: "video-1", status: completeStatus } });
  }) as typeof fetch;

  const transport: PartTransport = async (url, body, onBytes) => {
    const partNumber = Number(new URL(url).searchParams.get("partNumber"));
    onBytes(Math.floor(body.size / 2));
    onBytes(body.size);
    stored.set(partNumber, body.size);
    return { status: 200, etag: `"e${partNumber}"` };
  };

  return { fetch: fetchImpl, transport, stored, calls, completed: () => completedWith };
}

const file = (size: number) => new Blob([new Uint8Array(size)]);
const base = {
  apiBaseUrl: "https://api.test",
  session: { videoId: "video-1", token: "rp_ut_x" },
  wait: async () => undefined,
};

describe("uploadVideo", () => {
  it("uploads every part, completes with ordered ETags and reports monotonic progress", async () => {
    const server = fakeServer(10);
    const progress: number[] = [];
    const result = await uploadVideo({
      ...base,
      file: file(10),
      fetch: server.fetch,
      transport: server.transport,
      onProgress: (p) => progress.push(p.uploadedBytes),
    });

    expect(result).toEqual({ id: "video-1", status: "queued" });
    expect(server.completed()).toEqual([
      { partNumber: 1, etag: '"e1"' },
      { partNumber: 2, etag: '"e2"' },
      { partNumber: 3, etag: '"e3"' },
    ]);
    expect(progress.at(-1)).toBe(10);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it("completes when storage hides the ETag header (CORS without ExposeHeaders, e.g. Supabase)", async () => {
    const server = fakeServer(10);
    const hidden: PartTransport = async (url, body, onBytes) => {
      await server.transport(url, body, onBytes);
      return { status: 200, etag: null };
    };
    const result = await uploadVideo({
      ...base,
      file: file(10),
      fetch: server.fetch,
      transport: hidden,
    });
    expect(result.status).toBe("queued");
    expect(server.stored.size).toBe(3); // every part sent once, none retried
    // No ETags to vouch for: the server checks the parts against storage's own list.
    expect(server.completed()).toEqual([]);
  });

  it("rejects a completed upload the server didn't accept (a non-video, a deleted video)", async () => {
    const server = fakeServer(10, [], "failed");
    await expect(
      uploadVideo({ ...base, file: file(10), fetch: server.fetch, transport: server.transport }),
    ).rejects.toMatchObject({ name: "UploadError", code: "api_error" });
  });

  it("resumes: parts storage already has are skipped and counted as progress", async () => {
    const server = fakeServer(10, [1, 2]);
    const sent: number[] = [];
    const progress: number[] = [];
    const transport: PartTransport = (url, body, onBytes) => {
      sent.push(Number(new URL(url).searchParams.get("partNumber")));
      return server.transport(url, body, onBytes);
    };
    await uploadVideo({
      ...base,
      file: file(10),
      fetch: server.fetch,
      transport,
      onProgress: (p) => progress.push(p.uploadedBytes),
    });

    expect(sent).toEqual([3]);
    expect(progress[0]).toBe(8);
  });

  it("retries network errors and 5xx responses", async () => {
    const server = fakeServer(4);
    let failures = 0;
    const transport: PartTransport = async (url, body, onBytes) => {
      failures += 1;
      if (failures === 1) throw new TypeError("connection reset");
      if (failures === 2) return { status: 503, etag: null };
      return server.transport(url, body, onBytes);
    };
    await expect(
      uploadVideo({ ...base, file: file(4), fetch: server.fetch, transport }),
    ).resolves.toMatchObject({ status: "queued" });
    expect(failures).toBe(3);
  });

  it("re-signs after a 403 (expired URL)", async () => {
    const server = fakeServer(4);
    let rejected = false;
    const transport: PartTransport = async (url, body, onBytes) => {
      if (!rejected) {
        rejected = true;
        return { status: 403, etag: null };
      }
      return server.transport(url, body, onBytes);
    };
    await uploadVideo({ ...base, file: file(4), fetch: server.fetch, transport });
    expect(server.calls.filter((call) => call === "parts")).toHaveLength(2);
  });

  it("fails fast on a non-retryable rejection", async () => {
    const server = fakeServer(4);
    let attempts = 0;
    const transport: PartTransport = async () => {
      attempts += 1;
      return { status: 400, etag: null };
    };
    await expect(
      uploadVideo({ ...base, file: file(4), fetch: server.fetch, transport }),
    ).rejects.toMatchObject({ code: "part_failed", status: 400 });
    expect(attempts).toBe(1);
    expect(server.completed()).toBeNull();
  });

  it("gives up after maxAttempts so the caller can resume later", async () => {
    const server = fakeServer(4);
    const transport: PartTransport = async () => {
      throw new TypeError("offline");
    };
    const error = await uploadVideo({
      ...base,
      file: file(4),
      fetch: server.fetch,
      transport,
      maxAttempts: 3,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).message).toContain("after 3 attempts");
  });

  it("surfaces API errors with their status", async () => {
    const fetchImpl = (async () =>
      Response.json(
        { error: { code: "conflict", message: "Upload is no longer in progress" } },
        { status: 409 },
      )) as typeof fetch;
    await expect(uploadVideo({ ...base, file: file(4), fetch: fetchImpl })).rejects.toMatchObject({
      code: "api_error",
      status: 409,
    });
  });

  it("stops when aborted", async () => {
    const server = fakeServer(12);
    const controller = new AbortController();
    const transport: PartTransport = async (url, body, onBytes) => {
      controller.abort();
      return server.transport(url, body, onBytes);
    };
    await expect(
      uploadVideo({
        ...base,
        file: file(12),
        fetch: server.fetch,
        transport,
        signal: controller.signal,
        concurrency: 1,
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(server.completed()).toBeNull();
  });
});

describe("backoffDelay", () => {
  it("grows exponentially up to the cap, with full jitter", () => {
    const max = () => 0.999_999;
    expect(backoffDelay(0, { baseMs: 100, maxMs: 1000 }, max)).toBe(99);
    expect(backoffDelay(3, { baseMs: 100, maxMs: 1000 }, max)).toBe(799);
    expect(backoffDelay(10, { baseMs: 100, maxMs: 1000 }, max)).toBe(999);
    expect(backoffDelay(5, { baseMs: 100, maxMs: 1000 }, () => 0)).toBe(0);
  });
});
