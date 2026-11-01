/**
 * What the player knows about the network, and the start-quality decision made from it.
 *
 * Sources: `navigator.connection` (Chromium/Android: Data Saver, effective type, downlink) and
 * hls.js's own bandwidth estimate, carried across videos. iOS Safari exposes neither (no
 * Network Information API, and native HLS hides its throughput), so iPhones get the default
 * start (720p) and rely on Safari's ABR to step down on a slow network.
 */
export interface NetworkHints {
  saveData: boolean;
  effectiveType: string | null;
  downlinkBps: number | null;
}

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
  downlink?: number;
}

export function readNetworkHints(): NetworkHints {
  const connection =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  return {
    saveData: connection?.saveData === true,
    effectiveType: connection?.effectiveType ?? null,
    // `downlink` is in Mbit/s, rounded and capped at 10 by browsers: a coarse lower bound.
    downlinkBps: typeof connection?.downlink === "number" ? connection.downlink * 1e6 : null,
  };
}

/** Below this, start at the lowest rendition (a 720p first segment would stall). */
export const SLOW_NETWORK_BPS = 2_500_000;
const SLOW_EFFECTIVE_TYPES = new Set(["slow-2g", "2g", "3g"]);
/** Weight of a new sample in the moving average. */
const EWMA_ALPHA = 0.3;

/** Exponentially weighted throughput estimate, shared by all players in a feed. */
export class BandwidthEstimator {
  private value: number | null = null;

  observe(bitsPerSecond: number): void {
    if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return;
    this.value =
      this.value === null
        ? bitsPerSecond
        : this.value * (1 - EWMA_ALPHA) + bitsPerSecond * EWMA_ALPHA;
  }

  /**
   * Measured throughput in bits/s, or null before the first sample. `navigator.connection.downlink`
   * is deliberately not used as a fallback: it is a coarse, rounded RTT-based guess (often 1–2
   * Mbps on desktop) and made the first video start at the lowest rendition on a fast network.
   */
  estimate(): number | null {
    return this.value;
  }
}

export type StartQuality = "default" | "low";

/** Where a new video should start. "default" = 720p or the best rendition below it. */
export function chooseStartQuality(estimateBps: number | null, hints: NetworkHints): StartQuality {
  if (hints.saveData) return "low";
  if (hints.effectiveType && SLOW_EFFECTIVE_TYPES.has(hints.effectiveType)) return "low";
  if (estimateBps !== null && estimateBps < SLOW_NETWORK_BPS) return "low";
  return "default";
}

export interface RenditionInfo {
  name: string;
  width: number;
  height: number;
  bitrateKbps: number;
  fps: number | null;
}

/** The short side the default start aims for (matches the worker's StartRung). */
export const DEFAULT_START_SHORT_SIDE = 720;
/** Leave headroom: start on a rendition using at most this share of the estimate. */
const START_HEADROOM = 0.8;

/**
 * The rendition to start on: the best one up to 720p that the estimate sustains (or simply
 * the best up to 720p when nothing is known), and the lowest one for a "low" start.
 */
export function pickStartRendition(
  renditions: readonly RenditionInfo[],
  quality: StartQuality,
  estimateBps: number | null,
): RenditionInfo | null {
  const sorted = [...renditions].sort((a, b) => a.bitrateKbps - b.bitrateKbps);
  if (sorted.length === 0) return null;
  if (quality === "low") return sorted[0] ?? null;
  const eligible = sorted.filter((r) => Math.min(r.width, r.height) <= DEFAULT_START_SHORT_SIDE);
  const affordable =
    estimateBps === null
      ? eligible
      : eligible.filter((r) => r.bitrateKbps * 1000 <= estimateBps * START_HEADROOM);
  return affordable.at(-1) ?? sorted[0] ?? null;
}
