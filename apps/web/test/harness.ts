import { randomUUID } from "node:crypto";
import { createPool, createProject, type Pool, withTenant } from "@reelplane/db";
import { fetchTransport, type PartTransport } from "@reelplane/sdk-core";
import {
  createStorage,
  loadStorageConfig,
  MemoryObjectStorage,
  type ObjectStorage,
} from "@reelplane/storage";
import { afterAll, inject } from "vitest";
import type { RouteContext } from "@/lib/server/api-route.ts";
import type { AppDeps } from "@/lib/server/deps.ts";
import { bind } from "@/lib/server/endpoint.ts";
import * as uploads from "@/lib/server/endpoints/uploads.ts";
import * as videos from "@/lib/server/endpoints/videos.ts";
import { DEFAULT_UPLOAD_LIMITS, type UploadLimits } from "@/lib/server/uploads/limits.ts";

export const API = "http://api.test";
export const PEPPER = "web-test-pepper-0123456789abcdef0123";
export const ORIGIN = "https://app.example.com";
const MIB = 1024 * 1024;

/** 5 MiB is S3's minimum part size, so tests can run against real storage too. */
export const TEST_LIMITS: UploadLimits = { ...DEFAULT_UPLOAD_LIMITS, partSizeBytes: 5 * MIB };

export interface StorageUnderTest {
  name: string;
  storage: ObjectStorage;
  transport: PartTransport;
}

export function storagesUnderTest(): StorageUnderTest[] {
  const memory = new MemoryObjectStorage();
  const memoryTransport: PartTransport = async (url, body, onBytes) => {
    const result = memory.handlePresignedPut(url, new Uint8Array(await body.arrayBuffer()));
    if (result.status === 200) onBytes(body.size);
    return result;
  };
  const list: StorageUnderTest[] = [
    { name: "memory", storage: memory, transport: memoryTransport },
  ];
  if (process.env.STORAGE_INTEGRATION === "1") {
    list.push({
      name: loadStorageConfig().provider,
      storage: createStorage(),
      transport: fetchTransport,
    });
  }
  return list;
}

export function testPool(): Pool {
  const pool = createPool(inject("databaseUrl"), { max: 6 });
  afterAll(() => pool.end());
  return pool;
}

export async function newProject(pool: Pool) {
  return createProject(
    pool,
    {
      ownerId: randomUUID(),
      name: `upload-test-${randomUUID().slice(0, 6)}`,
      allowedOrigins: [ORIGIN],
    },
    PEPPER,
  );
}

/** Every endpoint bound to test dependencies, plus a `fetch` that dispatches to them. */
export function bindApi(deps: AppDeps) {
  const d = () => deps;
  const routes = {
    createUpload: bind(uploads.createUpload, d),
    signParts: bind(uploads.signParts, d),
    completeUpload: bind(uploads.completeUpload, d),
    abortUpload: bind(uploads.abortUpload, d),
    listVideos: bind(videos.listProjectVideos, d),
    getVideo: bind(videos.getProjectVideo, d),
    deleteVideo: bind(videos.deleteProjectVideo, d),
  };
  const ctx = (id?: string): RouteContext => ({ params: Promise.resolve(id ? { id } : {}) });

  const fetchShim = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const match = /^\/v1\/uploads\/([^/]+)\/(parts|complete)$/.exec(path);
    if (match && request.method === "POST") {
      const handler = match[2] === "parts" ? routes.signParts : routes.completeUpload;
      return handler(request, ctx(match[1]));
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return { routes, ctx, fetch: fetchShim };
}

export function apiRequest(
  path: string,
  options: {
    method?: string;
    credential?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.credential) headers.set("authorization", `Bearer ${options.credential}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${API}${path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.body === undefined ? null : JSON.stringify(options.body),
  });
}

/** A fake MP4: real `ftyp` header, then filler. Enough for magic-byte checks. */
export function fakeMp4(size: number, brand = "isom"): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 0x18], 0);
  bytes.set(new TextEncoder().encode(`ftyp${brand}`), 4);
  for (let i = 12; i < size; i += 1) bytes[i] = i % 251;
  return bytes;
}

export function toBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>]);
}

export async function jobCount(pool: Pool, projectId: string, videoId: string): Promise<number> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<{ n: number }>(
      "select count(*)::int as n from reelplane.jobs where video_id = $1",
      [videoId],
    );
    return rows[0]?.n ?? 0;
  });
}

export async function eventTypes(
  pool: Pool,
  projectId: string,
  videoId: string,
): Promise<string[]> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<{ type: string }>(
      "select type from reelplane.video_events where video_id = $1 order by id",
      [videoId],
    );
    return rows.map((row) => row.type);
  });
}

export async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Inserts a ready video the way the pipeline leaves it, `hoursAgo` old. */
export async function readyVideo(
  db: Pool,
  projectId: string,
  options: {
    hoursAgo?: number;
    creatorId?: string;
    likes?: number;
    views?: number;
    completions?: number;
  } = {},
): Promise<string> {
  return withTenant(db, { projectId }, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into reelplane.videos (project_id, content_type, size_bytes, source_key, creator_id)
       values ($1, 'video/mp4', 1000, 'originals/x', $2) returning id`,
      [projectId, options.creatorId ?? null],
    );
    const id = rows[0]?.id ?? "";
    for (const status of ["queued", "processing"]) {
      await client.query("update reelplane.videos set status = $2 where id = $1", [id, status]);
    }
    await client.query(
      `update reelplane.videos
          set status = 'ready', master_playlist_key = $2, duration_ms = 5000, width = 720, height = 1280,
              ready_at = now() - make_interval(hours => $3), likes_count = $4, views_count = $5,
              completions_count = $6
        where id = $1`,
      [
        id,
        `media/${projectId}/${id}/a1/master.m3u8`,
        options.hoursAgo ?? 0,
        options.likes ?? 0,
        options.views ?? 0,
        options.completions ?? 0,
      ],
    );
    return id;
  });
}
