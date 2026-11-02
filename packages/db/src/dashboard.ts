import type { Pool } from "./pool.ts";
import { getProject, type Project } from "./projects.ts";
import { withTenant } from "./tenant.ts";
import type { VideoStatus } from "./videos.ts";

/**
 * The project, if `userId` owns it; null otherwise (also for a project that doesn't exist, so
 * the dashboard can't be used to probe other people's project ids). Every dashboard page and
 * action goes through this before touching a project's data.
 */
export async function getOwnedProject(
  pool: Pool,
  userId: string,
  projectId: string,
): Promise<Project | null> {
  const owned = await withTenant(pool, { userId }, async (client) => {
    const { rowCount } = await client.query(
      "select 1 from reelplane.projects where id = $1 and owner_id = $2",
      [projectId, userId],
    );
    return rowCount === 1;
  });
  return owned ? getProject(pool, projectId) : null;
}

/** Renames a project the user owns. */
export function renameProject(
  pool: Pool,
  userId: string,
  projectId: string,
  name: string,
): Promise<boolean> {
  return withTenant(pool, { userId }, async (client) => {
    const result = await client.query(
      "update reelplane.projects set name = $3 where id = $1 and owner_id = $2",
      [projectId, userId, name],
    );
    return result.rowCount === 1;
  });
}

/**
 * Deletes a video: status `deleted` (queues the video.deleted webhook), its queued job
 * cancelled and its stored objects queued for the worker's sweep. Returns the status it had,
 * or null if the project has no such video.
 */
export function deleteVideo(
  pool: Pool,
  projectId: string,
  videoId: string,
): Promise<VideoStatus | null> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<{ previous: VideoStatus | null }>(
      "select reelplane.delete_video($1) as previous",
      [videoId],
    );
    return rows[0]?.previous ?? null;
  });
}

export interface TimelineEvent {
  id: number;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  data: Record<string, unknown>;
  createdAt: Date;
}

/** A video's audit trail (status changes and job attempts), oldest first. */
export function videoTimeline(
  pool: Pool,
  projectId: string,
  videoId: string,
): Promise<TimelineEvent[]> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<{
      id: string;
      type: string;
      from_status: string | null;
      to_status: string | null;
      data: Record<string, unknown>;
      created_at: Date;
    }>(
      `select id, type, from_status, to_status, data, created_at
         from reelplane.video_events where video_id = $1 order by id`,
      [videoId],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      type: row.type,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      data: row.data,
      createdAt: row.created_at,
    }));
  });
}

export type JobState = "queued" | "running" | "succeeded" | "dead" | "cancelled";

export interface JobSummary {
  id: string;
  videoId: string;
  videoTitle: string | null;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  progress: number;
  worker: string | null;
  lastError: string | null;
  runAfter: Date;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Transcode metrics the worker recorded (encode time, ×realtime, ...). */
  metrics: Record<string, unknown> | null;
}

/** The project's jobs, newest first; optionally for one video or one state. */
export function listJobs(
  pool: Pool,
  projectId: string,
  options: { videoId?: string; state?: JobState; limit?: number } = {},
): Promise<JobSummary[]> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<{
      id: string;
      video_id: string;
      title: string | null;
      state: JobState;
      attempts: number;
      max_attempts: number;
      progress: number;
      lease_owner: string | null;
      last_error: string | null;
      run_after: Date;
      created_at: Date;
      started_at: Date | null;
      finished_at: Date | null;
      metrics: Record<string, unknown> | null;
    }>(
      `select j.id, j.video_id, v.title, j.state, j.attempts, j.max_attempts, j.progress,
              j.lease_owner, j.last_error, j.run_after, j.created_at, j.started_at,
              j.finished_at, j.metrics
         from reelplane.jobs j join reelplane.videos v on v.id = j.video_id
        where ($1::uuid is null or j.video_id = $1)
          and ($2::text is null or j.state = $2)
        order by j.created_at desc, j.id
        limit $3`,
      [options.videoId ?? null, options.state ?? null, options.limit ?? 100],
    );
    return rows.map((row) => ({
      id: row.id,
      videoId: row.video_id,
      videoTitle: row.title,
      state: row.state,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      progress: row.progress,
      worker: row.lease_owner,
      lastError: row.last_error,
      runAfter: row.run_after,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      metrics: row.metrics,
    }));
  });
}

export interface DailyPlayback {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  views: number;
  ttffP50: number | null;
  ttffP95: number | null;
  /** Rebuffers per view. */
  rebufferRate: number | null;
  /** Mean share of each video watched (0–1). */
  completionRate: number | null;
}

/**
 * Per-day playback analytics for the last `days` days (UTC), oldest first, with empty days
 * included so a chart's x axis is continuous. Same definitions as `playbackStats`.
 */
export function dailyPlayback(pool: Pool, projectId: string, days = 14): Promise<DailyPlayback[]> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<{
      day: string;
      views: number;
      ttff_p50: number | null;
      ttff_p95: number | null;
      rebuffer_rate: number | null;
      completion_rate: number | null;
    }>(
      `with days as (
         select generate_series(
                  (now() at time zone 'utc')::date - ($1::int - 1),
                  (now() at time zone 'utc')::date,
                  interval '1 day')::date as day
       ),
       recent as (
         select (created_at at time zone 'utc')::date as day, type, value_ms, data
           from reelplane.playback_events
          where created_at >= ((now() at time zone 'utc')::date - ($1::int - 1)) at time zone 'utc'
       )
       select to_char(d.day, 'YYYY-MM-DD') as day,
              count(*) filter (where r.type = 'watch')::int as views,
              percentile_cont(0.5) within group (order by r.value_ms) filter (where r.type = 'ttff') as ttff_p50,
              percentile_cont(0.95) within group (order by r.value_ms) filter (where r.type = 'ttff') as ttff_p95,
              count(*) filter (where r.type = 'rebuffer')::float
                / nullif(count(*) filter (where r.type = 'watch'), 0) as rebuffer_rate,
              avg(least((r.data->>'completion')::float, 1)) filter (where r.type = 'watch') as completion_rate
         from days d left join recent r on r.day = d.day
        group by d.day
        order by d.day`,
      [days],
    );
    return rows.map((row) => ({
      day: row.day,
      views: row.views,
      ttffP50: row.ttff_p50,
      ttffP95: row.ttff_p95,
      rebufferRate: row.rebuffer_rate,
      completionRate: row.completion_rate,
    }));
  });
}

export interface RenditionSummary {
  name: string;
  width: number;
  height: number;
  bitrateKbps: number;
  fps: number | null;
  codecs: string;
}

/** The ladder a video was published with, smallest first. */
export function listRenditions(
  pool: Pool,
  projectId: string,
  videoId: string,
): Promise<RenditionSummary[]> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<{
      name: string;
      width: number;
      height: number;
      bitrate_kbps: number;
      fps: string | null;
      codecs: string;
    }>(
      `select name, width, height, bitrate_kbps, fps, codecs from reelplane.renditions
        where video_id = $1 order by least(width, height), bitrate_kbps`,
      [videoId],
    );
    return rows.map((row) => ({
      name: row.name,
      width: row.width,
      height: row.height,
      bitrateKbps: row.bitrate_kbps,
      fps: row.fps === null ? null : Number(row.fps),
      codecs: row.codecs,
    }));
  });
}
