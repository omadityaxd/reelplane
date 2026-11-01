import type { Pool } from "./pool.ts";
import { withTenant } from "./tenant.ts";
import { decodeCursor, encodeCursor } from "./videos.ts";

export interface FeedVideo {
  id: string;
  title: string | null;
  creatorId: string | null;
  durationMs: number;
  width: number;
  height: number;
  likesCount: number;
  masterPlaylistKey: string;
  posterKey: string | null;
  placeholder: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  readyAt: Date;
  /** Trending only: the inputs and result of the score, for `?explain=1`. */
  score?: TrendingScore;
}

export interface TrendingScore {
  likes: number;
  views: number;
  completions: number;
  completionRate: number;
  ageHours: number;
  value: number;
}

export interface FeedPage {
  videos: FeedVideo[];
  nextCursor: string | null;
}

export type FeedSpec =
  | { kind: "latest" }
  | { kind: "trending" }
  | { kind: "creator"; creatorId: string };

interface FeedRow {
  id: string;
  title: string | null;
  creator_id: string | null;
  duration_ms: number;
  width: number;
  height: number;
  likes_count: number;
  views_count: number;
  completions_count: number;
  master_playlist_key: string;
  poster_key: string | null;
  placeholder: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  ready_at: Date;
  age_hours?: number;
  score?: number;
}

const COLUMNS = `id, title, creator_id, duration_ms, width, height, likes_count, views_count,
  completions_count, master_playlist_key, poster_key, placeholder, metadata, created_at, ready_at`;

function toFeedVideo(row: FeedRow): FeedVideo {
  const video: FeedVideo = {
    id: row.id,
    title: row.title,
    creatorId: row.creator_id,
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    likesCount: row.likes_count,
    masterPlaylistKey: row.master_playlist_key,
    posterKey: row.poster_key,
    placeholder: row.placeholder,
    metadata: row.metadata,
    createdAt: row.created_at,
    readyAt: row.ready_at,
  };
  if (row.score !== undefined && row.age_hours !== undefined) {
    video.score = {
      likes: row.likes_count,
      views: row.views_count,
      completions: row.completions_count,
      completionRate: row.views_count > 0 ? row.completions_count / row.views_count : 0,
      ageHours: Number(row.age_hours.toFixed(2)),
      value: Number(row.score.toFixed(6)),
    };
  }
  return video;
}

/**
 * Trending score (explainable on purpose, see docs/ARCHITECTURE.md):
 *
 *   engagement = 1 + 3·likes + 2·completions + 0.5·views
 *   quality    = 0.5 + completionRate          (0.5 … 1.5: rewards videos people finish)
 *   score      = engagement · quality / (ageHours + 2)^1.5
 *
 * The `(age + 2)^1.5` gravity is the Hacker News decay: fresh videos can rank without any
 * engagement yet, and every video fades unless people keep watching it.
 */
export const TRENDING_SQL = `
  (1 + 3 * likes_count + 2 * completions_count + 0.5 * views_count)
  * (0.5 + case when views_count > 0 then completions_count::float / views_count else 0 end)
  / power(extract(epoch from ($1::timestamptz - ready_at)) / 3600 + 2, 1.5)`;

/** Trending candidates: recent ready videos only, so the scan stays bounded. */
const TRENDING_CANDIDATES = 500;
const TRENDING_WINDOW_DAYS = 30;

interface TrendingCursor {
  asOf: string;
  offset: number;
}

function encodeTrendingCursor(cursor: TrendingCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeTrendingCursor(raw: string): TrendingCursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null) return null;
    const { asOf, offset } = value as Record<string, unknown>;
    if (typeof asOf !== "string" || Number.isNaN(Date.parse(asOf))) return null;
    if (
      typeof offset !== "number" ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > TRENDING_CANDIDATES
    ) {
      return null;
    }
    return { asOf, offset };
  } catch {
    return null;
  }
}

export interface FeedInput {
  projectId: string;
  feed: FeedSpec;
  limit: number;
  cursor?: string | undefined;
}

/** Throws RangeError for a malformed cursor. */
export function getFeed(pool: Pool, input: FeedInput): Promise<FeedPage> {
  return input.feed.kind === "trending"
    ? trendingFeed(pool, input)
    : chronologicalFeed(pool, input);
}

/**
 * Latest and per-creator feeds: keyset pagination on (ready_at, id), stable while new videos
 * arrive (a new upload never shifts or duplicates items on later pages).
 */
function chronologicalFeed(pool: Pool, input: FeedInput): Promise<FeedPage> {
  const after = input.cursor ? decodeCursor(input.cursor) : null;
  if (input.cursor && !after) throw new RangeError("invalid cursor");
  const creatorId = input.feed.kind === "creator" ? input.feed.creatorId : null;
  return withTenant(pool, { projectId: input.projectId }, async (client) => {
    const { rows } = await client.query<FeedRow>(
      `select ${COLUMNS} from reelplane.videos
        where status = 'ready'
          and ($1::text is null or creator_id = $1)
          and ($2::timestamptz is null or (ready_at, id) < ($2, $3::uuid))
        order by ready_at desc, id desc
        limit $4`,
      [creatorId, after?.createdAt ?? null, after?.id ?? null, input.limit + 1],
    );
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      videos: page.map(toFeedVideo),
      nextCursor: rows.length > input.limit && last ? encodeCursor(last.ready_at, last.id) : null,
    };
  });
}

/**
 * Trending: scores are computed "as of" the first page's time, carried in the cursor, so the
 * ordering does not shift while someone scrolls through pages.
 */
function trendingFeed(pool: Pool, input: FeedInput): Promise<FeedPage> {
  const cursor = input.cursor ? decodeTrendingCursor(input.cursor) : null;
  if (input.cursor && !cursor) throw new RangeError("invalid cursor");
  const asOf = cursor?.asOf ?? new Date().toISOString();
  const offset = cursor?.offset ?? 0;
  return withTenant(pool, { projectId: input.projectId }, async (client) => {
    const { rows } = await client.query<FeedRow>(
      `with candidates as (
         select ${COLUMNS} from reelplane.videos
          where status = 'ready' and ready_at <= $1::timestamptz
            and ready_at > $1::timestamptz - make_interval(days => $4)
          order by ready_at desc
          limit $5
       )
       select *, (extract(epoch from ($1::timestamptz - ready_at)) / 3600)::float8 as age_hours,
              (${TRENDING_SQL})::float8 as score
         from candidates
        order by score desc, id desc
        offset $2 limit $3`,
      [asOf, offset, input.limit + 1, TRENDING_WINDOW_DAYS, TRENDING_CANDIDATES],
    );
    const page = rows.slice(0, input.limit);
    return {
      videos: page.map(toFeedVideo),
      nextCursor:
        rows.length > input.limit
          ? encodeTrendingCursor({ asOf, offset: offset + input.limit })
          : null,
    };
  });
}
