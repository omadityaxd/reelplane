import type { Pool } from "./pool.ts";
import { withTenant } from "./tenant.ts";

export type PlaybackEventType = "ttff" | "rebuffer" | "watch" | "quality_switch" | "error";

export interface PlaybackEventInput {
  videoId: string;
  sessionId: string;
  type: PlaybackEventType;
  valueMs?: number | undefined;
  data?: Record<string, unknown> | undefined;
}

/** A watch counts as a completion when at least this much of the video was seen. */
export const COMPLETION_THRESHOLD = 0.9;

/**
 * Stores a batch of playback events and folds `watch` events into the videos' view and
 * completion counters (used by the trending score), in one transaction. Events for videos that
 * are not this project's (RLS hides them) or not ready are dropped. Returns how many were kept.
 */
export function recordPlaybackEvents(
  pool: Pool,
  projectId: string,
  events: PlaybackEventInput[],
): Promise<number> {
  if (events.length === 0) return Promise.resolve(0);
  return withTenant(pool, { projectId }, async (client) => {
    const payload = JSON.stringify(
      events.map((event) => ({
        video_id: event.videoId,
        session_id: event.sessionId,
        type: event.type,
        value_ms: event.valueMs ?? null,
        data: event.data ?? {},
      })),
    );
    const inserted = await client.query(
      `insert into reelplane.playback_events (project_id, video_id, session_id, type, value_ms, data)
       select $1, e.video_id, e.session_id, e.type, e.value_ms, e.data
         from jsonb_to_recordset($2::jsonb)
              as e(video_id uuid, session_id text, type text, value_ms integer, data jsonb)
         join reelplane.videos v on v.id = e.video_id and v.status = 'ready'`,
      [projectId, payload],
    );
    await client.query(
      `update reelplane.videos v
          set views_count = v.views_count + w.views,
              completions_count = v.completions_count + w.completions
         from (
           select e.video_id,
                  count(*)::int as views,
                  count(*) filter (where (e.data->>'completion')::float >= $3)::int as completions
             from jsonb_to_recordset($2::jsonb) as e(video_id uuid, type text, data jsonb)
            where e.type = 'watch'
            group by e.video_id
         ) w
        where v.id = w.video_id and v.project_id = $1 and v.status = 'ready'`,
      [projectId, payload, COMPLETION_THRESHOLD],
    );
    return inserted.rowCount ?? 0;
  });
}

/** Likes are idempotent per (video, viewer). Returns the new count, or null if not found. */
export function setLike(
  pool: Pool,
  projectId: string,
  videoId: string,
  viewerId: string,
  liked: boolean,
): Promise<number | null> {
  return withTenant(pool, { projectId }, async (client) => {
    const exists = await client.query(
      `select 1 from reelplane.videos where id = $1 and status = 'ready'`,
      [videoId],
    );
    if (exists.rowCount === 0) return null;
    if (liked) {
      await client.query(
        `insert into reelplane.likes (project_id, video_id, viewer_id) values ($1, $2, $3)
         on conflict do nothing`,
        [projectId, videoId, viewerId],
      );
    } else {
      await client.query(`delete from reelplane.likes where video_id = $1 and viewer_id = $2`, [
        videoId,
        viewerId,
      ]);
    }
    const { rows } = await client.query<{ likes_count: number }>(
      `select likes_count from reelplane.videos where id = $1`,
      [videoId],
    );
    return rows[0]?.likes_count ?? null;
  });
}

export interface PlaybackStats {
  sessions: number;
  ttffP50: number | null;
  ttffP95: number | null;
  rebufferRate: number | null;
  completionRate: number | null;
}

/** Aggregates used by the dashboard and BENCHMARKS.md (time to first frame p50/p95 etc.). */
export function playbackStats(
  pool: Pool,
  projectId: string,
  sinceHours = 24 * 7,
): Promise<PlaybackStats> {
  return withTenant(pool, { projectId }, async (client) => {
    const { rows } = await client.query<{
      sessions: number;
      ttff_p50: number | null;
      ttff_p95: number | null;
      rebuffer_rate: number | null;
      completion_rate: number | null;
    }>(
      `with recent as (
         select * from reelplane.playback_events
          where created_at > now() - make_interval(hours => $1)
       )
       select (select count(distinct session_id)::int from recent) as sessions,
              (select percentile_cont(0.5) within group (order by value_ms) from recent where type = 'ttff') as ttff_p50,
              (select percentile_cont(0.95) within group (order by value_ms) from recent where type = 'ttff') as ttff_p95,
              (select count(*) filter (where type = 'rebuffer')::float / nullif(count(*) filter (where type = 'watch'), 0) from recent) as rebuffer_rate,
              (select avg(least((data->>'completion')::float, 1)) from recent where type = 'watch') as completion_rate`,
      [sinceHours],
    );
    const row = rows[0];
    return {
      sessions: row?.sessions ?? 0,
      ttffP50: row?.ttff_p50 ?? null,
      ttffP95: row?.ttff_p95 ?? null,
      rebufferRate: row?.rebuffer_rate ?? null,
      completionRate: row?.completion_rate ?? null,
    };
  });
}
