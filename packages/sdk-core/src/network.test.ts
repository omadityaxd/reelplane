import { describe, expect, it } from "vitest";
import {
  BandwidthEstimator,
  chooseStartQuality,
  type NetworkHints,
  pickStartRendition,
  type RenditionInfo,
} from "./network.ts";

const unknown: NetworkHints = { saveData: false, effectiveType: null, downlinkBps: null };

const vertical1080: RenditionInfo[] = [
  { name: "1080p", width: 1080, height: 1920, bitrateKbps: 6100, fps: 60 },
  { name: "240p", width: 240, height: 426, bitrateKbps: 450, fps: 60 },
  { name: "720p", width: 720, height: 1280, bitrateKbps: 3300, fps: 60 },
  { name: "480p", width: 480, height: 854, bitrateKbps: 1400, fps: 60 },
];

describe("chooseStartQuality", () => {
  it("starts high when nothing is known (iOS Safari exposes no network info)", () => {
    expect(chooseStartQuality(null, unknown)).toBe("default");
  });

  it("starts low with Data Saver, on slow connections or a low estimate", () => {
    expect(chooseStartQuality(null, { ...unknown, saveData: true })).toBe("low");
    expect(chooseStartQuality(null, { ...unknown, effectiveType: "3g" })).toBe("low");
    expect(chooseStartQuality(1_200_000, unknown)).toBe("low");
    expect(chooseStartQuality(20_000_000, unknown)).toBe("default");
  });
});

describe("pickStartRendition", () => {
  it("starts at 720p, never above, when the network is unknown or fast", () => {
    expect(pickStartRendition(vertical1080, "default", null)?.name).toBe("720p");
    expect(pickStartRendition(vertical1080, "default", 50_000_000)?.name).toBe("720p");
  });

  it("drops to what the estimate sustains, with headroom", () => {
    expect(pickStartRendition(vertical1080, "default", 3_000_000)?.name).toBe("480p");
  });

  it("starts at the lowest rendition for a low start, and copes with small ladders", () => {
    expect(pickStartRendition(vertical1080, "low", 50_000_000)?.name).toBe("240p");
    expect(pickStartRendition(vertical1080.slice(1, 2), "default", null)?.name).toBe("240p");
    expect(pickStartRendition([], "default", null)).toBeNull();
  });
});

describe("BandwidthEstimator", () => {
  it("smooths measured samples and never guesses from the coarse downlink hint", () => {
    const estimator = new BandwidthEstimator();
    expect(estimator.estimate()).toBeNull();
    estimator.observe(10_000_000);
    estimator.observe(20_000_000);
    expect(estimator.estimate()).toBe(13_000_000);
    estimator.observe(Number.NaN);
    expect(estimator.estimate()).toBe(13_000_000);
  });

  it("does not start low just because the downlink hint is small", () => {
    expect(
      chooseStartQuality(null, { ...unknown, effectiveType: "4g", downlinkBps: 1_450_000 }),
    ).toBe("default");
  });
});
