import type { RenditionInfo } from "./network.ts";

/** One video in a feed, as returned by `GET /v1/feeds/:feed`. */
export interface FeedItem {
  id: string;
  title: string | null;
  creatorId: string | null;
  durationMs: number;
  width: number;
  height: number;
  likesCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  playback: {
    /** Master playlist starting at 720p (or the best rendition below). */
    hlsUrl: string;
    /** Same renditions, starting at the lowest (slow networks, native HLS). */
    hlsLowStartUrl?: string;
    posterUrl: string | null;
    placeholder: string | null;
    renditions?: RenditionInfo[];
  };
}

export type FeedName = "latest" | "trending" | `creator:${string}`;

export interface FeedClientOptions {
  apiBaseUrl: string;
  publishableKey: string;
  feed: FeedName;
  pageSize?: number;
  fetch?: typeof fetch;
}

export class FeedError extends Error {
  override readonly name = "FeedError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A page of a feed as the API returns it (also what a server renders as `initialPage`). */
export interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
}

/** Pages through a feed with the API's opaque cursors. */
export class FeedClient {
  private cursor: string | null = null;
  private exhausted = false;
  private inFlight: Promise<FeedItem[]> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FeedClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get hasMore(): boolean {
    return !this.exhausted;
  }

  /** Continues after a page that was fetched elsewhere (server-rendered `initialPage`). */
  resumeAfter(page: FeedPage): void {
    this.cursor = page.nextCursor;
    this.exhausted = page.nextCursor === null;
  }

  /** Fetches the next page; concurrent calls share one request. */
  nextPage(): Promise<FeedItem[]> {
    if (this.exhausted) return Promise.resolve([]);
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async load(): Promise<FeedItem[]> {
    const { apiBaseUrl, publishableKey, feed, pageSize = 10 } = this.options;
    const url = new URL(`${apiBaseUrl.replace(/\/+$/, "")}/v1/feeds/${encodeURIComponent(feed)}`);
    url.searchParams.set("limit", String(pageSize));
    if (this.cursor) url.searchParams.set("cursor", this.cursor);
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${publishableKey}` },
    });
    const body = (await response.json().catch(() => ({}))) as {
      data?: FeedItem[];
      nextCursor?: string | null;
      error?: { message?: string };
    };
    if (!response.ok || !body.data) {
      throw new FeedError(
        body.error?.message ?? `Feed request failed (HTTP ${response.status})`,
        response.status,
      );
    }
    this.cursor = body.nextCursor ?? null;
    this.exhausted = this.cursor === null;
    return body.data;
  }
}
