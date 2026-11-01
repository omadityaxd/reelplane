import type Hls from "hls.js";

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

  /**
   * Loads `src` for preloading (small buffer, starting at the lowest rendition) or playing.
   * Calling it again with the same src only changes the mode, so a preloaded video is
   * promoted without reloading anything.
   */
  async load(src: string, mode: "preload" | "play"): Promise<void> {
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
    const transform = this.options.urlTransform;
    const hls = new HlsClass({
      // Start at the lowest rendition for an instant first frame; ABR then ramps up.
      startLevel: 0,
      capLevelToPlayerSize: true,
      maxBufferLength: mode === "preload" ? PRELOAD_BUFFER_SECONDS : PLAY_BUFFER_SECONDS,
      backBufferLength: 10,
      ...(transform
        ? { xhrSetup: (xhr: XMLHttpRequest, url: string) => xhr.open("GET", transform(url), true) }
        : {}),
    });
    hls.on(HlsClass.Events.LEVEL_SWITCHED, (_event, data) => {
      const level = hls.levels[data.level];
      if (level) this.options.onQualitySwitch?.({ height: level.height, bitrate: level.bitrate });
    });
    hls.on(HlsClass.Events.ERROR, (_event, data) => {
      if (data.fatal) this.options.onError?.(`${data.type}: ${data.details}`);
    });
    hls.loadSource(transformed);
    hls.attachMedia(this.video);
    this.hls = hls;
  }

  private setMode(mode: "preload" | "play"): void {
    if (this.hls)
      this.hls.config.maxBufferLength =
        mode === "preload" ? PRELOAD_BUFFER_SECONDS : PLAY_BUFFER_SECONDS;
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
