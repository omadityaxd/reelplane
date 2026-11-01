/**
 * Playback quality metrics: time to first frame, rebuffers, watch time and completion, and
 * quality switches. Collected per view and sent to the API in batches.
 */
export type MetricType = "ttff" | "rebuffer" | "watch" | "quality_switch" | "error";

export interface PlaybackMetric {
  videoId: string;
  sessionId: string;
  type: MetricType;
  valueMs?: number;
  data?: Record<string, string | number | boolean | null>;
}

export type MetricSink = (metric: PlaybackMetric) => void;

/** A minimal view of HTMLVideoElement, so the tracker can be tested without a browser. */
export interface TrackableVideo extends EventTarget {
  readonly currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  requestVideoFrameCallback?: (callback: () => void) => number;
}

export interface ViewContext {
  videoId: string;
  sessionId: string;
  /** Whether the video had been preloaded before it became active. */
  preloaded: boolean;
  /** What made it active: the first video of the page, or a swipe. */
  trigger: "initial" | "swipe";
  engine: string;
}

const LOOP_RESET_SECONDS = 0.5;
/**
 * Shorter `waiting` gaps are pipeline hand-offs (segment boundaries, loops), not freezes a
 * viewer notices. The first ingest from a real session recorded 91 "rebuffers" of 2–6 ms each.
 */
export const MIN_REBUFFER_MS = 100;

/**
 * Tracks one view of one video, from activation until `end()`. Time to first frame is
 * measured from activation (the swipe settling) to the first painted frame, which is
 * exactly the "swipe-to-play" delay a viewer perceives.
 */
export class ViewTracker {
  private firstFrameAt: number | null = null;
  private rebufferStart: number | null = null;
  private watchedMs = 0;
  private lastTime = 0;
  private maxPosition = 0;
  private loops = 0;
  private ended = false;
  private readonly listeners: [string, EventListener][] = [];

  constructor(
    private readonly video: TrackableVideo,
    private readonly context: ViewContext,
    private readonly emit: MetricSink,
    private readonly activatedAt: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.listen("playing", () => this.onPlaying());
    this.listen("waiting", () => this.onWaiting());
    this.listen("timeupdate", () => this.onTimeUpdate());
  }

  /** Called by the engine when ABR changes rendition. */
  qualitySwitch(height: number, bitrate: number): void {
    if (this.firstFrameAt === null) return; // initial level selection is not a switch
    this.send("quality_switch", undefined, { height, bitrate });
  }

  error(message: string): void {
    this.send("error", undefined, { message: message.slice(0, 200) });
  }

  /** Ends the view (swiped away, page hidden) and reports watch time and completion. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const [type, listener] of this.listeners) this.video.removeEventListener(type, listener);
    this.finishRebuffer();
    if (this.firstFrameAt === null) return; // never started: nothing was watched
    const duration =
      Number.isFinite(this.video.duration) && this.video.duration > 0 ? this.video.duration : 0;
    const completion =
      this.loops > 0 ? 1 : duration > 0 ? Math.min(1, this.maxPosition / duration) : 0;
    this.send("watch", Math.round(this.watchedMs), {
      completion: Number(completion.toFixed(3)),
      loops: this.loops,
    });
  }

  private listen(type: string, handler: () => void): void {
    const listener: EventListener = () => handler();
    this.video.addEventListener(type, listener);
    this.listeners.push([type, listener]);
  }

  private onPlaying(): void {
    if (this.firstFrameAt === null) {
      const report = () => {
        if (this.firstFrameAt !== null || this.ended) return;
        this.firstFrameAt = this.now();
        this.lastTime = this.video.currentTime;
        this.send("ttff", Math.round(this.firstFrameAt - this.activatedAt), {
          preloaded: this.context.preloaded,
          trigger: this.context.trigger,
          engine: this.context.engine,
        });
      };
      // `playing` can fire a frame early; the frame callback marks the frame actually painted.
      if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(report);
      else report();
      return;
    }
    this.finishRebuffer();
  }

  private onWaiting(): void {
    // A loop back to the start is a seek and briefly fires `waiting`; that is not a stall.
    if (this.video.seeking) return;
    if (this.firstFrameAt !== null && this.rebufferStart === null) this.rebufferStart = this.now();
  }

  private finishRebuffer(): void {
    if (this.rebufferStart === null) return;
    const duration = Math.round(this.now() - this.rebufferStart);
    this.rebufferStart = null;
    if (duration >= MIN_REBUFFER_MS) this.send("rebuffer", duration);
  }

  private onTimeUpdate(): void {
    if (this.firstFrameAt === null) return;
    const time = this.video.currentTime;
    if (time + LOOP_RESET_SECONDS < this.lastTime) {
      this.loops += 1; // looped back to the start
    } else if (!this.video.paused && time > this.lastTime) {
      this.watchedMs += (time - this.lastTime) * 1000;
    }
    this.maxPosition = Math.max(this.maxPosition, time);
    this.lastTime = time;
  }

  private send(type: MetricType, valueMs?: number, data?: PlaybackMetric["data"]): void {
    const metric: PlaybackMetric = {
      videoId: this.context.videoId,
      sessionId: this.context.sessionId,
      type,
    };
    if (valueMs !== undefined) metric.valueMs = valueMs;
    if (data) metric.data = data;
    this.emit(metric);
  }
}

export interface MetricsQueueOptions {
  apiBaseUrl: string;
  publishableKey: string;
  /** Flush when this many metrics are queued (default 20). */
  batchSize?: number;
  /** And at least this often (default 10 s). */
  intervalMs?: number;
  fetch?: typeof fetch;
}

/**
 * Batches metrics and sends them to `POST /v1/playback-events`. On page hide it flushes with
 * `keepalive` and no custom headers (the key goes in the URL), which the browser delivers even
 * as the page unloads and which needs no CORS preflight.
 */
export class MetricsQueue {
  private queue: PlaybackMetric[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly onHide = () => {
    if (document.visibilityState === "hidden") this.flush(true);
  };
  /** Safari fires `pagehide` reliably on navigation where `visibilitychange` may not. */
  private readonly onPageHide = () => this.flush(true);

  constructor(private readonly options: MetricsQueueOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(false), this.options.intervalMs ?? 10_000);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onHide);
      window.addEventListener("pagehide", this.onPageHide);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onHide);
      window.removeEventListener("pagehide", this.onPageHide);
    }
    this.flush(true);
  }

  push = (metric: PlaybackMetric): void => {
    this.queue.push(metric);
    if (this.queue.length >= (this.options.batchSize ?? 20)) this.flush(false);
  };

  flush(unloading: boolean): void {
    if (this.queue.length === 0) return;
    const events = this.queue.splice(0, 100);
    const base = `${this.options.apiBaseUrl.replace(/\/+$/, "")}/v1/playback-events`;
    const body = JSON.stringify({ events });
    const request = unloading
      ? this.fetchImpl(`${base}?key=${encodeURIComponent(this.options.publishableKey)}`, {
          method: "POST",
          body,
          keepalive: true,
          headers: { "content-type": "text/plain" },
        })
      : this.fetchImpl(base, {
          method: "POST",
          body,
          headers: {
            authorization: `Bearer ${this.options.publishableKey}`,
            "content-type": "application/json",
          },
        });
    // Metrics are best-effort: a failed batch is dropped, never retried into a loop.
    request.catch(() => undefined);
  }
}

export function newSessionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
