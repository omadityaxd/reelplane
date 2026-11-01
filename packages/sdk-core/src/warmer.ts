/**
 * Keeps the next video's player warm.
 *
 * Measured in Chrome (docs/BENCHMARKS.md): a preloaded <video> that has never played takes
 * 140–210 ms from play() to its first new frame, even with the whole clip buffered: decoder and
 * renderer start lazily on first play and are torn down again some seconds after a pause. One
 * that played moments ago starts in 6–25 ms. So the likely next video plays a single frame
 * (muted, offscreen) and pauses, and repeats that every few seconds while it waits.
 */
const REWARM_INTERVAL_MS = 4000;
/** Rewind before warming once a warmed video has crept this far from the start. */
const MAX_DRIFT_SECONDS = 0.5;
const FRAME_TIMEOUT_MS = 100;
const HAVE_FUTURE_DATA = 3;

export class Warmer {
  private video: HTMLVideoElement | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Warms `video` (or stops warming when null). Called whenever the next item changes. */
  target(video: HTMLVideoElement | null): void {
    if (video === this.video) return;
    this.stop();
    this.video = video;
    if (video) void this.cycle(video, this.generation);
  }

  stop(): void {
    this.generation += 1; // any warm-up in flight must not pause what it no longer owns
    this.video = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async cycle(video: HTMLVideoElement, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    if (video.readyState < HAVE_FUTURE_DATA) {
      video.addEventListener("canplay", () => void this.cycle(video, generation), { once: true });
      return;
    }
    try {
      if (video.currentTime > MAX_DRIFT_SECONDS) video.currentTime = 0;
      await video.play();
      await nextFrame(video);
    } catch {
      return; // autoplay refused, element reused, …: warming is best-effort
    }
    if (generation !== this.generation) return; // it became the active video: keep playing
    video.pause();
    this.timer = setTimeout(() => void this.cycle(video, generation), REWARM_INTERVAL_MS);
  }
}

function nextFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FRAME_TIMEOUT_MS);
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}
