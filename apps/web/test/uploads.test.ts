import { type PartTransport, UploadError, uploadVideo } from "@reelplane/sdk-core";
import { describe, expect, it } from "vitest";
import type { AppDeps } from "@/lib/server/deps.ts";
import {
  API,
  apiRequest,
  bindApi,
  body,
  eventTypes,
  fakeMp4,
  jobCount,
  newProject,
  ORIGIN,
  PEPPER,
  storagesUnderTest,
  TEST_LIMITS,
  testPool,
  toBlob,
} from "./harness.ts";

const pool = testPool();
const MIB = 1024 * 1024;
const instant = async () => undefined;

interface Session {
  video: { id: string; status: string };
  upload: { videoId: string; token: string; partSize: number; partCount: number };
}

describe.each(storagesUnderTest())("upload path ($name storage)", ({ storage, transport }) => {
  const deps: AppDeps = { pool, pepper: PEPPER, storage, limits: TEST_LIMITS };
  const api = bindApi(deps);

  async function startUpload(
    secretKey: string,
    bytes: Uint8Array,
    extra: Record<string, unknown> = {},
  ) {
    const response = await api.routes.createUpload(
      apiRequest("/v1/uploads", {
        credential: secretKey,
        body: {
          contentType: "video/mp4",
          sizeBytes: bytes.byteLength,
          filename: "clip.mp4",
          ...extra,
        },
      }),
    );
    expect(response.status).toBe(201);
    return (await body<{ data: Session }>(response)).data;
  }

  function upload(
    session: Session,
    bytes: Uint8Array,
    overrides: { transport?: PartTransport; maxAttempts?: number } = {},
  ) {
    return uploadVideo({
      apiBaseUrl: API,
      file: toBlob(bytes),
      session: { videoId: session.upload.videoId, token: session.upload.token },
      fetch: api.fetch,
      transport: overrides.transport ?? transport,
      maxAttempts: overrides.maxAttempts ?? 4,
      wait: instant,
    });
  }

  it("uploads in parts straight to storage and queues exactly one job", async () => {
    const { project, secretKey } = await newProject(pool);
    const bytes = fakeMp4(11 * MIB);
    const session = await startUpload(secretKey.key, bytes);
    expect(session.upload.partCount).toBe(3);
    expect(session.video.status).toBe("uploading");

    const progress: number[] = [];
    const result = await uploadVideo({
      apiBaseUrl: API,
      file: toBlob(bytes),
      session: session.upload,
      fetch: api.fetch,
      transport,
      wait: instant,
      onProgress: (p) => progress.push(p.fraction),
    });

    expect(result.status).toBe("queued");
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b)); // never goes backwards
    expect((await storage.headObject(`originals/${project.id}/${result.id}/source`))?.size).toBe(
      bytes.byteLength,
    );
    expect(await jobCount(pool, project.id, result.id)).toBe(1);
    expect(await eventTypes(pool, project.id, result.id)).toEqual([
      "video.created",
      "video.queued",
      "job.queued",
    ]);
  });

  it("resumes after a dropped connection, re-sending only the missing parts", async () => {
    const { project, secretKey } = await newProject(pool);
    const bytes = fakeMp4(11 * MIB);
    const session = await startUpload(secretKey.key, bytes);

    // First attempt: part 2 never gets through (network down), so the upload fails.
    const flaky: PartTransport = async (url, partBody, onBytes, signal) => {
      if (new URL(url).searchParams.get("partNumber") === "2") throw new TypeError("network down");
      return transport(url, partBody, onBytes, signal);
    };
    await expect(
      upload(session, bytes, { transport: flaky, maxAttempts: 2 }),
    ).rejects.toBeInstanceOf(UploadError);

    // Second attempt with the same session: only part 2 is sent.
    const sent: string[] = [];
    const counting: PartTransport = (url, partBody, onBytes, signal) => {
      sent.push(new URL(url).searchParams.get("partNumber") ?? "?");
      return transport(url, partBody, onBytes, signal);
    };
    const result = await upload(session, bytes, { transport: counting });

    expect(sent).toEqual(["2"]);
    expect(result.status).toBe("queued");
    expect(await jobCount(pool, project.id, result.id)).toBe(1);
  });

  it("re-signs a part whose URL expired (403) and carries on", async () => {
    const { secretKey } = await newProject(pool);
    const bytes = fakeMp4(6 * MIB);
    const session = await startUpload(secretKey.key, bytes);
    let rejectedOnce = false;
    const expiring: PartTransport = async (url, partBody, onBytes, signal) => {
      if (!rejectedOnce) {
        rejectedOnce = true;
        return { status: 403, etag: null };
      }
      return transport(url, partBody, onBytes, signal);
    };
    await expect(upload(session, bytes, { transport: expiring })).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("completing twice, or concurrently, still creates one job", async () => {
    const { project, secretKey } = await newProject(pool);
    const bytes = fakeMp4(2 * MIB);
    const session = await startUpload(secretKey.key, bytes);
    const result = await upload(session, bytes);

    const complete = () =>
      api.routes.completeUpload(
        apiRequest(`/v1/uploads/${result.id}/complete`, {
          credential: session.upload.token,
          body: {},
        }),
        api.ctx(result.id),
      );
    const replies = await Promise.all([complete(), complete(), complete()]);

    expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200]);
    expect(await jobCount(pool, project.id, result.id)).toBe(1);
  });

  it("refuses to complete while parts are missing", async () => {
    const { secretKey } = await newProject(pool);
    const bytes = fakeMp4(11 * MIB);
    const session = await startUpload(secretKey.key, bytes);
    const response = await api.routes.completeUpload(
      apiRequest(`/v1/uploads/${session.upload.videoId}/complete`, {
        credential: session.upload.token,
        body: {},
      }),
      api.ctx(session.upload.videoId),
    );
    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({ error: { details: { missingParts: [1, 2, 3] } } });
  });

  it("rejects a non-video renamed to .mp4 (an HEIC photo) after upload", async () => {
    const { project, secretKey } = await newProject(pool);
    const bytes = fakeMp4(1 * MIB, "heic");
    const session = await startUpload(secretKey.key, bytes);

    await expect(upload(session, bytes)).rejects.toMatchObject({ status: 400 });
    const video = await api.routes.getVideo(
      apiRequest(`/v1/videos/${session.upload.videoId}`, {
        method: "GET",
        credential: secretKey.key,
      }),
      api.ctx(session.upload.videoId),
    );
    expect(await body(video)).toMatchObject({
      data: { status: "failed", failureReason: "unsupported_file_type" },
    });
    expect(
      await storage.headObject(`originals/${project.id}/${session.upload.videoId}/source`),
    ).toBeNull();
    expect(await jobCount(pool, project.id, session.upload.videoId)).toBe(0);
    // A retried complete must not report the rejected upload as a success. (Its upload token
    // already stopped working; the secret key still reaches the endpoint.)
    const retry = await api.routes.completeUpload(
      apiRequest(`/v1/uploads/${session.upload.videoId}/complete`, {
        credential: secretKey.key,
        body: {},
      }),
      api.ctx(session.upload.videoId),
    );
    expect(retry.status).toBe(409);
  });
});

describe("upload sessions: validation, idempotency and access", () => {
  const [{ storage }] = storagesUnderTest() as [ReturnType<typeof storagesUnderTest>[number]];
  const deps: AppDeps = { pool, pepper: PEPPER, storage, limits: TEST_LIMITS };
  const api = bindApi(deps);

  const create = (credential: string, payload: unknown, headers: Record<string, string> = {}) =>
    api.routes.createUpload(apiRequest("/v1/uploads", { credential, body: payload, headers }));

  it.each([
    [{ contentType: "image/png", sizeBytes: 1000 }, "contentType"],
    [{ contentType: "video/mp4", sizeBytes: 101 * MIB }, "too large"],
    [{ contentType: "video/mp4", sizeBytes: 1000, durationMs: 61_000 }, "too long"],
    [{ contentType: "video/mp4", sizeBytes: 0 }, "sizeBytes"],
    [{ contentType: "video/mp4", sizeBytes: 1000, extra: true }, "extra"],
  ])("rejects %j", async (payload, mention) => {
    const { secretKey } = await newProject(pool);
    const response = await create(secretKey.key, payload);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(mention);
  });

  it("does not let a publishable key create uploads", async () => {
    const { publishableKey } = await newProject(pool);
    const response = await create(publishableKey.key, {
      contentType: "video/mp4",
      sizeBytes: 1000,
    });
    expect(response.status).toBe(403);
  });

  it("replays a retried create with the same Idempotency-Key instead of creating a duplicate", async () => {
    const { secretKey } = await newProject(pool);
    const payload = { contentType: "video/mp4", sizeBytes: 1000 };
    const headers = { "idempotency-key": "retry-me" };

    const first = await create(secretKey.key, payload, headers);
    const second = await create(secretKey.key, payload, headers);
    const firstBody = await body<{ data: Session }>(first);
    const secondBody = await body<{ data: Session }>(second);

    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(secondBody.data.video.id).toBe(firstBody.data.video.id);

    const list = await api.routes.listVideos(
      apiRequest("/v1/videos", { method: "GET", credential: secretKey.key }),
    );
    expect((await body<{ data: unknown[] }>(list)).data).toHaveLength(1);
  });

  it("rejects reusing an Idempotency-Key with a different body", async () => {
    const { secretKey } = await newProject(pool);
    const headers = { "idempotency-key": "same-key" };
    await create(secretKey.key, { contentType: "video/mp4", sizeBytes: 1000 }, headers);
    const response = await create(
      secretKey.key,
      { contentType: "video/mp4", sizeBytes: 2000 },
      headers,
    );
    expect(response.status).toBe(409);
  });

  it("scopes idempotency keys per project", async () => {
    const a = await newProject(pool);
    const b = await newProject(pool);
    const payload = { contentType: "video/mp4", sizeBytes: 1000 };
    const headers = { "idempotency-key": "shared" };
    const first = await body<{ data: Session }>(await create(a.secretKey.key, payload, headers));
    const second = await create(b.secretKey.key, payload, headers);
    expect(second.headers.get("idempotent-replayed")).toBeNull();
    expect((await body<{ data: Session }>(second)).data.video.id).not.toBe(first.data.video.id);
  });

  it("binds an upload token to its own video", async () => {
    const { secretKey } = await newProject(pool);
    const one = await body<{ data: Session }>(
      await create(secretKey.key, { contentType: "video/mp4", sizeBytes: 1000 }),
    );
    const two = await body<{ data: Session }>(
      await create(secretKey.key, { contentType: "video/mp4", sizeBytes: 1000 }),
    );

    const wrongVideo = await api.routes.signParts(
      apiRequest(`/v1/uploads/${two.data.upload.videoId}/parts`, {
        credential: one.data.upload.token,
        body: {},
      }),
      api.ctx(two.data.upload.videoId),
    );
    expect(wrongVideo.status).toBe(401);

    const createWithToken = await create(one.data.upload.token, {
      contentType: "video/mp4",
      sizeBytes: 1000,
    });
    expect(createWithToken.status).toBe(403);
  });

  it("checks an upload token's browser origin against the project (and the app itself)", async () => {
    const { secretKey } = await newProject(pool);
    const session = (
      await body<{ data: Session }>(
        await create(secretKey.key, { contentType: "video/mp4", sizeBytes: 1000 }),
      )
    ).data;
    const sign = (origin: string) =>
      api.routes.signParts(
        apiRequest(`/v1/uploads/${session.upload.videoId}/parts`, {
          credential: session.upload.token,
          body: {},
          headers: { origin },
        }),
        api.ctx(session.upload.videoId),
      );
    expect((await sign(ORIGIN)).status).toBe(200);
    expect((await sign(API)).status).toBe(200); // the dashboard's upload button: same origin
    expect((await sign("https://evil.example")).status).toBe(403);
  });

  it("hides one project's uploads and videos from another project's secret key", async () => {
    const a = await newProject(pool);
    const b = await newProject(pool);
    const session = (
      await body<{ data: Session }>(
        await create(a.secretKey.key, { contentType: "video/mp4", sizeBytes: 1000 }),
      )
    ).data;
    const id = session.upload.videoId;

    const sign = await api.routes.signParts(
      apiRequest(`/v1/uploads/${id}/parts`, { credential: b.secretKey.key, body: {} }),
      api.ctx(id),
    );
    const complete = await api.routes.completeUpload(
      apiRequest(`/v1/uploads/${id}/complete`, { credential: b.secretKey.key, body: {} }),
      api.ctx(id),
    );
    const get = await api.routes.getVideo(
      apiRequest(`/v1/videos/${id}`, { method: "GET", credential: b.secretKey.key }),
      api.ctx(id),
    );

    expect([sign.status, complete.status, get.status]).toEqual([404, 404, 404]);
  });

  it("deletes a video once, and only with its own project's secret key", async () => {
    const a = await newProject(pool);
    const b = await newProject(pool);
    const id = (
      await body<{ data: Session }>(
        await create(a.secretKey.key, { contentType: "video/mp4", sizeBytes: 1000 }),
      )
    ).data.upload.videoId;
    const del = (credential: string) =>
      api.routes.deleteVideo(
        apiRequest(`/v1/videos/${id}`, { method: "DELETE", credential }),
        api.ctx(id),
      );

    expect((await del(b.secretKey.key)).status).toBe(404);
    expect((await del(a.publishableKey.key)).status).toBe(403);
    const first = await del(a.secretKey.key);
    expect(first.status).toBe(200);
    expect(await body(first)).toEqual({
      data: { id, status: "deleted", previousStatus: "uploading" },
    });
    expect((await del(a.secretKey.key)).status).toBe(404);
    const get = await api.routes.getVideo(
      apiRequest(`/v1/videos/${id}`, { method: "GET", credential: a.secretKey.key }),
      api.ctx(id),
    );
    expect(get.status).toBe(404);
  });

  it("aborts an upload: storage parts are freed and the token stops working", async () => {
    const { secretKey } = await newProject(pool);
    const session = (
      await body<{ data: Session }>(
        await create(secretKey.key, { contentType: "video/mp4", sizeBytes: 1000 }),
      )
    ).data;
    const id = session.upload.videoId;
    const abort = await api.routes.abortUpload(
      apiRequest(`/v1/uploads/${id}`, { method: "DELETE", credential: session.upload.token }),
      api.ctx(id),
    );
    expect(abort.status).toBe(200);
    expect((await body<{ data: { status: string } }>(abort)).data.status).toBe("deleted");

    const again = await api.routes.signParts(
      apiRequest(`/v1/uploads/${id}/parts`, { credential: session.upload.token, body: {} }),
      api.ctx(id),
    );
    expect(again.status).toBe(401);
  });

  it("paginates the video list with a stable cursor", async () => {
    const { secretKey } = await newProject(pool);
    for (let i = 0; i < 5; i += 1)
      await create(secretKey.key, { contentType: "video/mp4", sizeBytes: 1000 + i });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
      const page = await body<{ data: { id: string }[]; nextCursor: string | null }>(
        await api.routes.listVideos(
          apiRequest(`/v1/videos${query}`, { method: "GET", credential: secretKey.key }),
        ),
      );
      seen.push(...page.data.map((video) => video.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    const bad = await api.routes.listVideos(
      apiRequest("/v1/videos?cursor=nope", { method: "GET", credential: secretKey.key }),
    );
    expect(bad.status).toBe(400);
  });
});
