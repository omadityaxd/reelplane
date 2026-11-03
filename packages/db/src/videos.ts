import type { Pool, PoolClient } from "./pool.ts";
import { withTenant } from "./tenant.ts";

export type VideoStatus = "uploading" | "queued" | "processing" | "ready" | "failed" | "deleted";

export interface Video {
  id: string;
  projectId: string;
  status: VideoStatus;
  failureReason: string | null;
  creatorId: string | null;
  title: string | null;
  contentType: string;
  sizeBytes: number;
  sourceKey: string;
  uploadId: string | null;
  uploadExpiresAt: Date | null;
  partSizeBytes: number | null;
  originalFilename: string | null;
  declaredDurationMs: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  masterPlaylistKey: string | null;
  posterKey: string | null;
  thumbnailKeys: string[];
  placeholder: string | null;
  isShowcase: boolean;
  likesCount: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  readyAt: Date | null;
  /** Set when viewer reports hid the video from feeds (see unhideVideo). */
  hiddenAt: Date | null;
}

interface VideoRow {
  id: string;
  project_id: string;
  status: VideoStatus;
  failure_reason: string | null;
  creator_id: string | null;
  title: string | null;
  content_type: string;
  size_bytes: string;
  source_key: string;
  upload_id: string | null;
  upload_expires_at: Date | null;
  part_size_bytes: number | null;
  original_filename: string | null;
  declared_duration_ms: number | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  master_playlist_key: string | null;
  poster_key: string | null;
  thumbnail_keys: string[];
  placeholder: string | null;
  is_showcase: boolean;
  likes_count: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  ready_at: Date | null;
  hidden_at: Date | null;
}

const VIDEO_COLUMNS = `id, project_id, status, failure_reason, creator_id, title, content_type,
  size_bytes, source_key, upload_id, upload_expires_at, part_size_bytes, original_filename,
  declared_duration_ms, duration_ms, width, height, master_playlist_key, poster_key,
  thumbnail_keys, placeholder, is_showcase, likes_count, metadata, created_at, updated_at, ready_at,
  hidden_at`;

function toVideo(row: VideoRow): Video {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    failureReason: row.failure_reason,
    creatorId: row.creator_id,
    title: row.title,
    contentType: row.content_type,
    // bigint arrives as a string; uploads are capped far below 2^53.
    sizeBytes: Number(row.size_bytes),
    sourceKey: row.source_key,
    uploadId: row.upload_id,
    uploadExpiresAt: row.upload_expires_at,
    partSizeBytes: row.part_size_bytes,
    originalFilename: row.original_filename,
    declaredDurationMs: row.declared_duration_ms,
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    masterPlaylistKey: row.master_playlist_key,
    posterKey: row.poster_key,
    thumbnailKeys: row.thumbnail_keys,
    placeholder: row.placeholder,
    isShowcase: row.is_showcase,
    likesCount: row.likes_count,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readyAt: row.ready_at,
    hiddenAt: row.hidden_at,
  };
}

export interface NewUploadingVideo {
  id: string;
  projectId: string;
  contentType: string;
  sizeBytes: number;
  sourceKey: string;
  uploadId: string;
  uploadTokenHash: Buffer;
  uploadTtlSeconds: number;
  partSizeBytes: number;
  originalFilename?: string | undefined;
  declaredDurationMs?: number | undefined;
  title?: string | undefined;
  creatorId?: string | undefined;
  metadata?: Record<string, string> | undefined;
}

export function insertUploadingVideo(pool: Pool, input: NewUploadingVideo): Promise<Video> {
  return withTenant(pool, { projectId: input.projectId }, async (client) => {
    const { rows } = await client.query<VideoRow>(
      `insert into reelplane.videos
         (id, project_id, status, content_type, size_bytes, source_key, upload_id, upload_token_hash,
          upload_expires_at, part_size_bytes, original_filename, declared_duration_ms, title, creator_id, metadata)
       values ($1, $2, 'uploading', $3, $4, $5, $6, $7, now() + make_interval(secs => $8), $9, $10, $11, $12, $13, $14)
       returning ${VIDEO_COLUMNS}`,
      [
        input.id,
        input.projectId,
        input.contentType,
        input.sizeBytes,
        input.sourceKey,
        input.uploadId,
        input.uploadTokenHash,
        input.uploadTtlSeconds,
        input.partSizeBytes,
        input.originalFilename ?? null,
        input.declaredDurationMs ?? null,
        input.title ?? null,
        input.creatorId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("video insert returned no row");
    return toVideo(row);
  });
}

export function getVideo(pool: Pool, projectId: string, videoId: string): Promise<Video | null> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<VideoRow>(
      `select ${VIDEO_COLUMNS} from reelplane.videos where id = $1`,
      [videoId],
    );
    return rows[0] ? toVideo(rows[0]) : null;
  });
}

export interface VideoPage {
  videos: Video[];
  /** Opaque cursor for the next page, or null at the end. */
  nextCursor: string | null;
}

export interface ListVideosInput {
  projectId: string;
  limit: number;
  cursor?: string | undefined;
  status?: VideoStatus | undefined;
}

/** Keyset cursor over (created_at desc, id desc): stable under concurrent inserts. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed;
    if (typeof createdAt !== "string" || typeof id !== "string") return null;
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { createdAt: date, id };
  } catch {
    return null;
  }
}

export function listVideos(pool: Pool, input: ListVideosInput): Promise<VideoPage> {
  const after = input.cursor ? decodeCursor(input.cursor) : null;
  if (input.cursor && !after) throw new RangeError("invalid cursor");
  return withTenant(pool, { projectId: input.projectId }, async (client) => {
    const { rows } = await client.query<VideoRow>(
      `select ${VIDEO_COLUMNS} from reelplane.videos
        where status <> 'deleted'
          and ($1::text is null or status = $1)
          and ($2::timestamptz is null or (created_at, id) < ($2, $3::uuid))
        order by created_at desc, id desc
        limit $4`,
      [input.status ?? null, after?.createdAt ?? null, after?.id ?? null, input.limit + 1],
    );
    const page = rows.slice(0, input.limit).map(toVideo);
    const last = page.at(-1);
    return {
      videos: page,
      nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  });
}

export interface UploadTokenMatch {
  projectId: string;
  status: VideoStatus;
  allowedOrigins: string[];
}

export function authenticateUploadToken(
  pool: Pool,
  videoId: string,
  tokenHash: Buffer,
): Promise<UploadTokenMatch | null> {
  return withTenant(pool, {}, async (client) => {
    const { rows } = await client.query<{
      project_id: string;
      status: VideoStatus;
      allowed_origins: string[];
    }>("select * from reelplane.authenticate_upload_token($1, $2)", [videoId, tokenHash]);
    const row = rows[0];
    return row
      ? { projectId: row.project_id, status: row.status, allowedOrigins: row.allowed_origins }
      : null;
  });
}

async function lockVideo(client: PoolClient, videoId: string): Promise<Video | null> {
  const { rows } = await client.query<VideoRow>(
    `select ${VIDEO_COLUMNS} from reelplane.videos where id = $1 for update`,
    [videoId],
  );
  return rows[0] ? toVideo(rows[0]) : null;
}

export type QueueResult =
  | { outcome: "queued"; video: Video; jobId: string }
  | { outcome: "already_done"; video: Video }
  | { outcome: "not_found" };

/**
 * The upload → processing hand-off: moves the video `uploading → queued` and creates its
 * transcode job in ONE transaction, under a row lock. Concurrent or replayed completes see
 * the new status and return `already_done`, so a video can never get two jobs.
 */
export function queueUploadedVideo(
  pool: Pool,
  projectId: string,
  videoId: string,
): Promise<QueueResult> {
  return withTenant(pool, { projectId }, async (client) => {
    const current = await lockVideo(client, videoId);
    if (!current) return { outcome: "not_found" };
    if (current.status !== "uploading") return { outcome: "already_done", video: current };

    const { rows } = await client.query<VideoRow>(
      `update reelplane.videos set status = 'queued', upload_id = null
        where id = $1 returning ${VIDEO_COLUMNS}`,
      [videoId],
    );
    const job = await client.query<{ id: string }>(
      "insert into reelplane.jobs (video_id, project_id) values ($1, $2) returning id",
      [videoId, projectId],
    );
    const row = rows[0];
    const jobId = job.rows[0]?.id;
    if (!row || !jobId) throw new Error("queueing the video returned no row");
    return { outcome: "queued", video: toVideo(row), jobId };
  });
}

/** Moves an in-progress upload to a terminal status (failed / deleted) with a reason. */
export function endUpload(
  pool: Pool,
  projectId: string,
  videoId: string,
  status: "failed" | "deleted",
  reason: string | null,
): Promise<Video | null> {
  return withTenant(pool, { projectId }, async (client) => {
    const current = await lockVideo(client, videoId);
    if (current?.status !== "uploading") return current;
    const { rows } = await client.query<VideoRow>(
      `update reelplane.videos
          set status = $2, failure_reason = $3, upload_id = null, upload_token_hash = null,
              deleted_at = case when $2 = 'deleted' then now() end
        where id = $1 returning ${VIDEO_COLUMNS}`,
      [videoId, status, reason],
    );
    return rows[0] ? toVideo(rows[0]) : null;
  });
}
