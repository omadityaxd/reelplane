import { PlaybackEngine } from "./engine.ts";
import { FeedClient, type FeedItem, type FeedName } from "./feed-client.ts";
import { MetricsQueue, newSessionId, type PlaybackMetric, ViewTracker } from "./metrics.ts";
import { Warmer } from "./warmer.ts";
import { assignSlots, DEFAULT_WINDOW, planWindow, poolSize, type WindowOptions } from "./window.ts";

export interface FeedControllerOptions {
  apiBaseUrl: string;
  publishableKey: string;
  feed?: FeedName;
  pageSize?: number;
  /** Preload upcoming videos (default true). `false` is the baseline for benchmarks. */
  preload?: boolean;
  /** Override the window size (default: 2 ahead, 1 behind). */
  window?: WindowOptions;
  muted?: boolean;
  loop?: boolean;
  /** Send metrics to the API (default true). */
  sendMetrics?: boolean;
  /** Also receive every metric (dashboards, benchmarks). */
  onMetric?: (metric: PlaybackMetric) => void;
  /** Rewrites media URLs (benchmarks use it to defeat the HTTP cache). */
  urlTransform?: (url: string) => string;
  fetch?: typeof fetch;
}

export interface FeedState {
  items: FeedItem[];
  activeIndex: number;
  /** Slot → feed index shown in that slot's <video>, or null when idle. */
  slots: (number | null)[];
  muted: boolean;
  /** Paused by the viewer (tap). */
  paused: boolean;
  /** Autoplay was refused; the viewer must tap to start. */
  needsGesture: boolean;
  loading: boolean;
  error: string | null;
}

type Listener = (state: FeedState) => void;

/** Load the next page when the viewer gets within this many items of the end. */
const PREFETCH_THRESHOLD = 3;
/** A promoted video further in than this restarts from 0 (swiping back to a watched one). */
const RESTART_THRESHOLD_SECONDS = 0.5;

/**
 * Framework-free feed player. The UI renders one <video> per slot (see `slotCount`), positions
 * slot `s` at item `state.slots[s]`, and calls `setActive` when the visible item changes.
 */
export class FeedController {
  readonly slotCount: number;
  private readonly window: WindowOptions;
  private readonly client: FeedClient;
  private readonly metrics: MetricsQueue | null;
  private readonly sessionId = newSessionId();
  private engines: PlaybackEngine[] = [];
  private tracker: ViewTracker | null = null;
  private readonly warmer = new Warmer();
  private listeners = new Set<Listener>();
  private hiddenPause = false;
  private destroyed = false;
  private state: FeedState;

  constructor(private readonly options: FeedControllerOptions) {
    this.window =
      options.window ?? (options.preload === false ? { ahead: 0, behind: 0 } : DEFAULT_WINDOW);
    this.slotCount = poolSize(this.window);
    this.client = new FeedClient({
      apiBaseUrl: options.apiBaseUrl,
      publishableKey: options.publishableKey,
      feed: options.feed ?? "trending",
      pageSize: options.pageSize ?? 10,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.metrics =
      options.sendMetrics === false
        ? null
        : new MetricsQueue({
            apiBaseUrl: options.apiBaseUrl,
            publishableKey: options.publishableKey,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          });
    this.state = {
      items: [],
      activeIndex: -1,
      slots: Array.from({ length: this.slotCount }, () => null),
      muted: options.muted ?? true,
      paused: false,
      needsGesture: false,
      loading: false,
      error: null,
    };
  }

  getState(): FeedState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Hands the controller its pool of video elements (exactly `slotCount`). */
  attach(videos: HTMLVideoElement[]): void {
    if (videos.length !== this.slotCount)
      throw new Error(`expected ${this.slotCount} video elements`);
    this.engines = videos.map((video) => {
      // Autoplay rules: muted + inline playback is what lets mobile browsers start without a tap.
      video.muted = this.state.muted;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.loop = this.options.loop ?? true;
      video.disableRemotePlayback = true;
      const engine: PlaybackEngine = new PlaybackEngine(video, {
        ...(this.options.urlTransform ? { urlTransform: this.options.urlTransform } : {}),
        onQualitySwitch: (level) => {
          if (this.isActiveEngine(engine)) this.tracker?.qualitySwitch(level.height, level.bitrate);
        },
        onError: (message) => {
          if (this.isActiveEngine(engine)) this.tracker?.error(message);
        },
      });
      return engine;
    });
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", this.onVisibility);
  }

  /** Loads the first page and starts playing the first video. */
  async start(): Promise<void> {
    this.metrics?.start();
    await this.loadMore();
    if (this.state.items.length > 0) this.setActive(0, "initial");
  }

  setActive(index: number, trigger: "initial" | "swipe" = "swipe"): void {
    if (
      this.destroyed ||
      index === this.state.activeIndex ||
      index < 0 ||
      index >= this.state.items.length
    )
      return;
    const activatedAt = performance.now();
    this.tracker?.end();
    this.tracker = null;
    this.update({ activeIndex: index, paused: false });
    this.applyWindow(activatedAt, trigger);
    if (index >= this.state.items.length - PREFETCH_THRESHOLD && this.client.hasMore) {
      void this.loadMore().then(() => this.applyWindow(null, trigger));
    }
  }

  togglePause(): void {
    const video = this.activeVideo();
    if (!video) return;
    if (video.paused) {
      this.update({ paused: false, needsGesture: false });
      void video.play().catch(() => undefined);
    } else {
      this.update({ paused: true });
      video.pause();
    }
  }

  setMuted(muted: boolean): void {
    for (const engine of this.engines) engine.video.muted = muted;
    this.update({ muted });
  }

  destroy(): void {
    this.destroyed = true;
    this.warmer.stop();
    this.tracker?.end();
    this.metrics?.stop();
    for (const engine of this.engines) engine.unload();
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", this.onVisibility);
    this.listeners.clear();
  }

  private isActiveEngine(engine: PlaybackEngine): boolean {
    const slot = this.state.slots.indexOf(this.state.activeIndex);
    return slot >= 0 && this.engines[slot] === engine;
  }

  private activeVideo(): HTMLVideoElement | null {
    const slot = this.state.slots.indexOf(this.state.activeIndex);
    return slot >= 0 ? (this.engines[slot]?.video ?? null) : null;
  }

  /**
   * Moves every slot to its role for the current active item. `activatedAt` is set when the
   * active item just changed (start a new view); null when only the window grew (new page).
   */
  private applyWindow(activatedAt: number | null, trigger: "initial" | "swipe"): void {
    const { items, activeIndex } = this.state;
    const plan = planWindow(activeIndex, items.length, this.window);
    const slots = assignSlots(this.state.slots, plan);
    this.update({ slots });

    slots.forEach((index, slot) => {
      const engine = this.engines[slot];
      if (!engine) return;
      const item = index === null ? undefined : items[index];
      if (!item) {
        if (engine.currentSrc) engine.unload();
        return;
      }
      if (plan.roles.get(index ?? -1) !== "play") {
        // Pausing first matters: the warmer may be playing this element (now N-1 or N+2).
        engine.video.pause();
        void engine.load(item.playback.hlsUrl, "preload");
        return;
      }
      if (activatedAt === null) return; // already playing
      const preloaded = engine.currentSrc === item.playback.hlsUrl;
      void this.play(engine, item, preloaded, activatedAt, trigger);
    });
    // Warm the likeliest next video (N+1); see warmer.ts.
    const nextSlot = slots.indexOf(activeIndex + 1);
    this.warmer.target(
      nextSlot >= 0 && this.window.ahead > 0 ? (this.engines[nextSlot]?.video ?? null) : null,
    );
  }

  private async play(
    engine: PlaybackEngine,
    item: FeedItem,
    preloaded: boolean,
    activatedAt: number,
    trigger: "initial" | "swipe",
  ): Promise<void> {
    const video = engine.video;
    // A kept video (swiping back) restarts from the top. A warmed or freshly preloaded video is
    // within a frame or two of the start, and a seek there would cost more than it fixes.
    if (preloaded && video.currentTime > RESTART_THRESHOLD_SECONDS) video.currentTime = 0;
    await engine.load(item.playback.hlsUrl, "play");
    if (this.destroyed || this.state.items[this.state.activeIndex]?.id !== item.id) return;
    const emit = (metric: PlaybackMetric) => {
      this.metrics?.push(metric);
      this.options.onMetric?.(metric);
    };
    this.tracker = new ViewTracker(
      video,
      {
        videoId: item.id,
        sessionId: this.sessionId,
        preloaded,
        trigger,
        engine: engine.kind ?? "unknown",
      },
      emit,
      activatedAt,
    );
    try {
      await video.play();
      this.update({ needsGesture: false });
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError")
        this.update({ needsGesture: true });
    }
  }

  private async loadMore(): Promise<void> {
    if (this.state.loading) return;
    this.update({ loading: true, error: null });
    try {
      const page = await this.client.nextPage();
      this.update({ items: [...this.state.items, ...page], loading: false });
    } catch (error) {
      this.update({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private readonly onVisibility = () => {
    const video = this.activeVideo();
    if (!video) return;
    if (document.visibilityState === "hidden") {
      this.hiddenPause = !video.paused;
      video.pause();
    } else if (this.hiddenPause && !this.state.paused) {
      this.hiddenPause = false;
      void video.play().catch(() => undefined);
    }
  };

  private update(patch: Partial<FeedState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
