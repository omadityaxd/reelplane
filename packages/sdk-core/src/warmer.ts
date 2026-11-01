import { readNetworkHints, SLOW_NETWORK_BPS } from "./network.ts";

/**
 * Keeps the next video's player warm.
 *
 * Measured in Chrome (docs/BENCHMARKS.md): a preloaded <video> that has never played takes
 * 140–210 ms from play() to its first new frame, even with the whole clip buffered: decoder and
 * renderer start lazily on first play and are torn down again some seconds after a pause. One
 * that played moments ago starts in 6–25 ms. So the likely next video plays a single frame
 * (muted, offscreen) and pauses, and repeats that every few seconds while it waits.
 *
 * It is adaptive (see `warmingAllowed`): off with Data Saver, on slow networks, when the user
 * prefers reduced data, and on a low battery that is not charging.
 */
const REWARM_INTERVAL_MS = 4000;
/** Rewind before warming once a warmed video has crept this far from the start. */
const MAX_DRIFT_SECONDS = 0.5;
const FRAME_TIMEOUT_MS = 100;
const HAVE_FUTURE_DATA = 3;
const LOW_BATTERY_LEVEL = 0.2;

interface BatteryLike extends EventTarget {
  level: number;
  charging: boolean;
}

let batteryLow = false;
let batteryWatched = false;

/** Battery Status API (Chromium only); iOS Safari does not expose battery state. */
function watchBattery(): void {
  if (batteryWatched || typeof navigator === "undefined") return;
  batteryWatched = true;
  const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> })
    .getBattery;
  if (typeof getBattery !== "function") return;
  getBattery
    .call(navigator)
    .then((battery) => {
      const update = () => {
        batteryLow = battery.level < LOW_BATTERY_LEVEL && !battery.charging;
      };
      update();
      battery.addEventListener("levelchange", update);
      battery.addEventListener("chargingchange", update);
    })
    .catch(() => undefined);
}

/** Whether warming is worth its (small) cost right now. */
export function warmingAllowed(estimateBps: number | null): boolean {
  watchBattery();
  const hints = readNetworkHints();
  if (hints.saveData || batteryLow) return false;
  if (hints.effectiveType && ["slow-2g", "2g", "3g"].includes(hints.effectiveType)) return false;
  if (estimateBps !== null && estimateBps < SLOW_NETWORK_BPS) return false;
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-data: reduce)").matches)
    return false;
  return true;
}

export class Warmer {
  private video: HTMLVideoElement | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private warmed = false;

  constructor(private readonly allowed: () => boolean = () => true) {}

  /** Whether the current target has been warmed at least once (debug overlay). */
  isActive(): boolean {
    return this.video !== null && this.warmed;
  }

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
    this.warmed = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(video: HTMLVideoElement, generation: number): void {
    this.timer = setTimeout(() => void this.cycle(video, generation), REWARM_INTERVAL_MS);
  }

  private async cycle(video: HTMLVideoElement, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    if (!this.allowed()) {
      this.warmed = false;
      this.schedule(video, generation); // conditions change (network, charging): look again later
      return;
    }
    if (video.readyState < HAVE_FUTURE_DATA) {
      video.addEventListener("canplay", () => void this.cycle(video, generation), { once: true });
      return;
    }
    try {
      if (video.currentTime > MAX_DRIFT_SECONDS) video.currentTime = 0;
      await video.play();
      await nextFrame(video);
    } catch {
      return; // autoplay refused (e.g. iOS Low Power Mode), element reused…: best-effort
    }
    if (generation !== this.generation) return; // it became the active video: keep playing
    video.pause();
    this.warmed = true;
    this.schedule(video, generation);
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
