import type Hls from "hls.js";
import type { BandwidthEstimator } from "./network.ts";

/**
 * Attaches an HLS source to a <video> element: hls.js where Media Source Extensions exist
 * (Chrome, Firefox, Edge, Android), the browser's native HLS on Apple devices (Safari, and every
 * iOS browser, which are all WebKit). hls.js is imported lazily, so pages that never play a
 * video, and Apple devices, never download it.
 */
export type EngineKind = "hls.js" | "native";

export interface EngineEvents {
  /** ABR moved to another rendition (hls.js only). */
  onQualitySwitch?: (level: { height: number; bitrate: number }) => void;
  onError?: (message: string) => void;
}

export interface EngineOptions extends EngineEvents {
  /** Rewrites every media request URL (benchmarks use it to defeat the HTTP cache). */
  urlTransform?: (url: string) => string;
  /** Shared throughput estimate: seeds ABR and learns from every fragment loaded. */
  bandwidth?: BandwidthEstimator;
}

export interface LoadOptions {
  /** Height of the rendition to start on (hls.js); native HLS starts on the playlist's first. */
  startHeight?: number | undefined;
}

export interface LevelInfo {
  height: number;
  width: number;
  bitrate: number;
}

type HlsModule = typeof import("hls.js");
let hlsModule: Promise<HlsModule> | null = null;

function loadHls(): Promise<HlsModule> {
  hlsModule ??= import("hls.js");
  return hlsModule;
}

/** Preloading keeps just enough buffered to start instantly: the first ~2 s segment. */
const PRELOAD_BUFFER_SECONDS = 3;
const PLAY_BUFFER_SECONDS = 20;
const PLAY_MAX_BUFFER_SECONDS = 60;

/**
 * hls.js treats `maxBufferLength` as a minimum: it keeps buffering up to `maxBufferSize` (60 MB)
 * or `maxMaxBufferLength` (600 s). Measured: preloaded videos downloaded whole clips. A preload
 * is now hard-capped to its first ~3 s, so swiping past a video costs ~1–2 segments of data.
 */
function bufferLimits(mode: "preload" | "play"): {
  maxBufferLength: number;
  maxMaxBufferLength: number;
} {
  return mode === "preload"
    ? { maxBufferLength: PRELOAD_BUFFER_SECONDS, maxMaxBufferLength: PRELOAD_BUFFER_SECONDS }
    : { maxBufferLength: PLAY_BUFFER_SECONDS, maxMaxBufferLength: PLAY_MAX_BUFFER_SECONDS };
}
/** Smaller fragments measure latency more than bandwidth. */
const MIN_SAMPLE_BYTES = 50_000;

/**
 * Faster ABR ramp-up than hls.js defaults (fast/slow EWMA 3/9 s, up factor 0.7): short videos
 * do not last long enough for a slow climb to matter, so react to measured bandwidth sooner.
 */
const ABR_CONFIG = {
  abrEwmaFastVoD: 2,
  abrEwmaSlowVoD: 5,
  abrBandWidthUpFactor: 0.8,
  abrBandWidthFactor: 0.9,
  testBandwidth: false,
} as const;

export function prefersNativeHls(video: HTMLVideoElement): boolean {
  const canPlayNative = video.canPlayType("application/vnd.apple.mpegurl") !== "";
  const apple = typeof navigator !== "undefined" && /Apple/.test(navigator.vendor ?? "");
  return canPlayNative && apple;
}

export class PlaybackEngine {
  private hls: Hls | null = null;
  private src: string | null = null;
  private generation = 0;
  kind: EngineKind | null = null;

  constructor(
    readonly video: HTMLVideoElement,
    private readonly options: EngineOptions = {},
  ) {}

  get currentSrc(): string | null {
    return this.src;
  }

  /** The rendition hls.js is playing (null for native HLS, which does not expose it). */
  currentLevel(): LevelInfo | null {
    const hls = this.hls;
    if (!hls || hls.currentLevel < 0) return null;
    const level = hls.levels[hls.currentLevel];
    return level ? { height: level.height, width: level.width, bitrate: level.bitrate } : null;
  }

  /**
   * Loads `src` for preloading (small buffer) or playing. Calling it again with the same src only
   * changes the mode, so a preloaded video is promoted without reloading anything.
   */
  async load(src: string, mode: "preload" | "play", options: LoadOptions = {}): Promise<void> {
    if (this.src === src) {
      this.setMode(mode);
      return;
    }
    this.unload();
    this.src = src;
    const generation = ++this.generation;
    const transformed = this.options.urlTransform ? this.options.urlTransform(src) : src;

    if (prefersNativeHls(this.video)) {
      this.kind = "native";
      this.video.preload = "auto";
      this.video.src = transformed;
      this.video.load();
      return;
    }

    const { default: HlsClass } = await loadHls();
    if (generation !== this.generation) return; // unloaded or replaced while importing
    if (!HlsClass.isSupported()) {
      this.kind = "native";
      this.video.src = transformed;
      this.video.load();
      return;
    }
    this.kind = "hls.js";
    this.hls = this.createHls(HlsClass, transformed, mode, options);
  }

  private createHls(
    HlsClass: HlsModule["default"],
    src: string,
    mode: "preload" | "play",
    options: LoadOptions,
  ): Hls {
    const transform = this.options.urlTransform;
    const estimate = this.options.bandwidth?.estimate();
    const hls = new HlsClass({
      ...ABR_CONFIG,
      // Seed ABR with what earlier videos measured, so it does not start from hls.js's 500 kbps
      // default guess and drop straight to the lowest rendition.
      ...(estimate ? { abrEwmaDefaultEstimate: estimate } : {}),
      capLevelToPlayerSize: true,
      ...bufferLimits(mode),
      backBufferLength: 10,
      ...(transform
        ? { xhrSetup: (xhr: XMLHttpRequest, url: string) => xhr.open("GET", transform(url), true) }
        : {}),
    });
    hls.on(HlsClass.Events.MANIFEST_PARSED, () => {
      // Start on the chosen rendition (levels are sorted by bitrate; match by height).
      const index =
        options.startHeight === undefined
          ? -1
          : hls.levels.findIndex((l) => l.height === options.startHeight);
      hls.startLevel = Math.max(index, 0);
    });
    // Measure throughput from each fragment's own load stats. (hls.bandwidthEstimate returns
    // hls.js's 500 kbps default guess until it has enough samples: feeding that back made the
    // next videos choose the low start on a 96 Mbps network.)
    hls.on(HlsClass.Events.FRAG_LOADED, (_event, data) => {
      const stats = data.frag.stats;
      const ms = stats.loading.end - stats.loading.start;
      if (stats.loaded >= MIN_SAMPLE_BYTES && ms > 0) {
        this.options.bandwidth?.observe((stats.loaded * 8 * 1000) / ms);
      }
    });
    hls.on(HlsClass.Events.LEVEL_SWITCHED, (_event, data) => {
      const level = hls.levels[data.level];
      if (level) this.options.onQualitySwitch?.({ height: level.height, bitrate: level.bitrate });
    });
    hls.on(HlsClass.Events.ERROR, (_event, data) => {
      if (data.fatal) this.options.onError?.(`${data.type}: ${data.details}`);
    });
    hls.loadSource(src);
    hls.attachMedia(this.video);
    return hls;
  }

  private setMode(mode: "preload" | "play"): void {
    if (this.hls) Object.assign(this.hls.config, bufferLimits(mode));
  }

  /** Frees the decoder, buffers and network for this element. */
  unload(): void {
    this.generation += 1;
    this.src = null;
    this.kind = null;
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
}
