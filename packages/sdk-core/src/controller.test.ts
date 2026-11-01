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
