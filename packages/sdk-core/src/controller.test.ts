import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedController } from "./controller.ts";

/**
 * A fake <video> that follows iOS Safari's rule: only one AUDIBLE media element plays at a
 * time; starting another audible one pauses the first. Desktop Chrome does not enforce this,
 * which is why the bug (warming an unmuted next video interrupted the active one every 4 s)
 * only showed up on an iPhone.
 */
class FakeVideo extends EventTarget {
  static all: FakeVideo[] = [];
  static interruptions = 0;
  muted = false;
  paused = true;
  playsInline = false;
  loop = false;
  disableRemotePlayback = false;
  preload = "";
  src = "";
  currentTime = 0;
  duration = 10;
  readyState = 4;
  buffered = { length: 0, start: () => 0, end: () => 0 };
  constructor() {
    super();
    FakeVideo.all.push(this);
  }
  canPlayType(): string {
    return "maybe";
  }
  setAttribute(): void {}
  removeAttribute(): void {
    this.src = "";
  }
  load(): void {}
  async play(): Promise<void> {
    if (!this.muted) {
      for (const other of FakeVideo.all) {
        if (other !== this && !other.paused && !other.muted) {
          other.pause();
          FakeVideo.interruptions += 1;
        }
      }
    }
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
  }
  pause(): void {
    this.paused = true;
  }
}

const items = Array.from({ length: 5 }, (_, i) => ({
  id: `video-${i}`,
  title: null,
  creatorId: null,
  durationMs: 10_000,
  width: 720,
  height: 1280,
  likesCount: 0,
  metadata: {},
  createdAt: new Date().toISOString(),
  playback: { hlsUrl: `https://cdn.test/${i}/master.m3u8`, posterUrl: null, placeholder: null },
}));

const feedFetch = (async () => Response.json({ data: items, nextCursor: null })) as typeof fetch;

describe("FeedController first page", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeVideo.all = [];
    vi.stubGlobal("navigator", { vendor: "Apple Computer, Inc." });
    vi.spyOn(Math, "random").mockReturnValue(0.5); // backoff delays: 500, 1000, 2000 ms
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A feed endpoint that answers with `statuses` in turn (0 = the network fails), then 200. */
  function flakyFeed(statuses: number[]) {
    let calls = 0;
    const fetchFeed = (async () => {
      const status = statuses[calls];
      calls += 1;
      if (status === 0) throw new TypeError("Failed to fetch");
      if (status !== undefined) return Response.json({ error: { message: "nope" } }, { status });
      return Response.json({ data: items, nextCursor: null });
    }) as typeof fetch;
    return { fetchFeed, calls: () => calls };
  }

  function controllerWith(fetchFeed: typeof fetch) {
    const controller = new FeedController({
      apiBaseUrl: "https://api.test",
      publishableKey: "rp_pk_test",
      feed: "latest",
      sendMetrics: false,
      fetch: fetchFeed,
    });
    controller.attach(
      Array.from(
        { length: controller.slotCount },
        () => new FakeVideo(),
      ) as unknown as HTMLVideoElement[],
    );
    return controller;
  }

  it("retries a first page lost to the network or a server error, then plays", async () => {
    const feed = flakyFeed([0, 503, 429]);
    const controller = controllerWith(feed.fetchFeed);
    const started = controller.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await started;

    expect(feed.calls()).toBe(4);
    expect(controller.getState()).toMatchObject({ error: null, loading: false, activeIndex: 0 });
    expect(controller.getState().items).toHaveLength(5);
  });

  it("does not retry a request the server refused for good", async () => {
    const feed = flakyFeed([401]);
    const controller = controllerWith(feed.fetchFeed);
    await controller.start();

    expect(feed.calls()).toBe(1);
    expect(controller.getState()).toMatchObject({ error: "nope", loading: false, activeIndex: -1 });
  });

  it("shows the error after its retries, and `retry()` loads the page and starts playing", async () => {
    const feed = flakyFeed([0, 0, 0, 0]);
    const controller = controllerWith(feed.fetchFeed);
    const started = controller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await started;
    expect(feed.calls()).toBe(4); // the first try and 3 retries
    expect(controller.getState()).toMatchObject({ error: "Failed to fetch", items: [] });

    await controller.retry(); // the viewer pressed "Try again"; the network is back
    expect(controller.getState()).toMatchObject({ error: null, activeIndex: 0 });
    expect(controller.getState().items).toHaveLength(5);
  });

  it("stops retrying once the feed is destroyed", async () => {
    const feed = flakyFeed([503, 503, 503, 503]);
    const controller = controllerWith(feed.fetchFeed);
    const started = controller.start();
    await vi.advanceTimersByTimeAsync(10);
    controller.destroy();
    await vi.advanceTimersByTimeAsync(10_000);
    await started;
    expect(feed.calls()).toBe(1);
  });
});

describe("FeedController sound and warming", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeVideo.all = [];
    FakeVideo.interruptions = 0;
    // Native-HLS path (as on an iPhone): no hls.js, no MediaSource.
    vi.stubGlobal("navigator", { vendor: "Apple Computer, Inc." });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function startedController() {
    const controller = new FeedController({
      apiBaseUrl: "https://api.test",
      publishableKey: "rp_pk_test",
      feed: "latest",
      sendMetrics: false,
      fetch: feedFetch,
    });
    const videos = Array.from({ length: controller.slotCount }, () => new FakeVideo());
    controller.attach(videos as unknown as HTMLVideoElement[]);
    await controller.start();
    await vi.advanceTimersByTimeAsync(100);
    return { controller, videos };
  }

  it("never lets warming interrupt an audible active video (iOS one-audible-element rule)", async () => {
    const { controller } = await startedController();
    controller.setMuted(false); // the viewer turns sound on
    controller.setActive(1); // and swipes to a preloaded, warmed video
    await vi.advanceTimersByTimeAsync(20_000); // five warm-up cycles

    const active = controller.activeVideo() as unknown as FakeVideo;
    expect(active.paused).toBe(false);
    expect(active.muted).toBe(false);
    expect(FakeVideo.interruptions).toBe(0);
  });

  it("keeps every non-active element muted, whatever the viewer's setting", async () => {
    const { controller, videos } = await startedController();
    controller.setMuted(false);
    controller.setActive(1);
    await vi.advanceTimersByTimeAsync(5_000);
    const active = controller.activeVideo();
    for (const video of videos) {
      if ((video as unknown) !== active) expect(video.muted).toBe(true);
    }
    controller.setMuted(true);
    expect((controller.activeVideo() as unknown as FakeVideo).muted).toBe(true);
  });
});
