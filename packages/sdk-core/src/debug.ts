import type { PlaybackEngine } from "./engine.ts";
import type { FeedItem } from "./feed-client.ts";
import type { RenditionInfo, StartQuality } from "./network.ts";

/** What the `?debug=1` overlay shows about the active video. */
export interface DebugInfo {
  engine: string;
  /** Rendition being played, e.g. "720p" (inferred from the decoded size on native HLS). */
  rendition: string | null;
  /** Decoded frame size actually on screen. */
  resolution: string | null;
  /** hls.js: the level's bitrate; native: the matching rendition's measured bitrate. */
  bitrateKbps: number | null;
  /** The rendition's encoded frame rate (from the ladder). */
  sourceFps: number | null;
  /** Frames actually presented per second, measured with requestVideoFrameCallback. */
  presentedFps: number | null;
  bufferAheadSeconds: number;
  droppedFrames: number | null;
  totalFrames: number | null;
  startQuality: StartQuality | null;
  estimateMbps: number | null;
  warming: boolean;
}

export interface DebugContext {
  startQuality: StartQuality | null;
  estimateBps: number | null;
  warming: boolean;
}

function bufferAhead(video: HTMLVideoElement): number {
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i += 1) {
    if (video.buffered.start(i) <= t + 0.05 && t <= video.buffered.end(i))
      return video.buffered.end(i) - t;
  }
  return 0;
}

function renditionForHeight(
  renditions: readonly RenditionInfo[],
  width: number,
  height: number,
): RenditionInfo | null {
  // Match on the short side (vertical and horizontal ladders alike).
  const short = Math.min(width, height);
  return renditions.find((r) => Math.min(r.width, r.height) === short) ?? null;
}

export function readDebugInfo(
  engine: PlaybackEngine,
  item: FeedItem,
  context: DebugContext,
): DebugInfo {
  const video = engine.video;
  const renditions = item.playback.renditions ?? [];
  const level = engine.currentLevel();
  const width = level?.width || video.videoWidth;
  const height = level?.height || video.videoHeight;
  const rendition = width && height ? renditionForHeight(renditions, width, height) : null;
  const quality =
    typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
  return {
    engine: engine.kind ?? "idle",
    rendition: rendition?.name ?? (height ? `${Math.min(width, height)}p` : null),
    resolution: video.videoWidth ? `${video.videoWidth}x${video.videoHeight}` : null,
    bitrateKbps: level ? Math.round(level.bitrate / 1000) : (rendition?.bitrateKbps ?? null),
    sourceFps: rendition?.fps ?? null,
    presentedFps: fpsMeters.get(video)?.fps ?? null,
    bufferAheadSeconds: Number(bufferAhead(video).toFixed(1)),
    droppedFrames: quality?.droppedVideoFrames ?? null,
    totalFrames: quality?.totalVideoFrames ?? null,
    startQuality: context.startQuality,
    estimateMbps:
      context.estimateBps === null ? null : Number((context.estimateBps / 1e6).toFixed(1)),
    warming: context.warming,
  };
}

/** Measures presented frames per second with requestVideoFrameCallback (debug only). */
class FpsMeter {
  fps: number | null = null;
  private running = true;
  private windowStart = 0;
  private framesAtStart = 0;

  constructor(private readonly video: HTMLVideoElement) {
    this.next();
  }

  stop(): void {
    this.running = false;
  }

  private next(): void {
    if (!this.running || typeof this.video.requestVideoFrameCallback !== "function") return;
    this.video.requestVideoFrameCallback((now, metadata) => {
      if (this.windowStart === 0) {
        this.windowStart = now;
        this.framesAtStart = metadata.presentedFrames;
      } else if (now - this.windowStart >= 1000) {
        this.fps = Math.round(
          ((metadata.presentedFrames - this.framesAtStart) * 1000) / (now - this.windowStart),
        );
        this.windowStart = now;
        this.framesAtStart = metadata.presentedFrames;
      }
      this.next();
    });
  }
}

const fpsMeters = new WeakMap<HTMLVideoElement, FpsMeter>();

/** Starts measuring presented fps on `video` (idempotent); returns a stop function. */
export function measureFps(video: HTMLVideoElement): () => void {
  let meter = fpsMeters.get(video);
  if (!meter) {
    meter = new FpsMeter(video);
    fpsMeters.set(video, meter);
  }
  const current = meter;
  return () => {
    current.stop();
    fpsMeters.delete(video);
  };
}
