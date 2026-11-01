import { describe, expect, it } from "vitest";
import {
  MIN_REBUFFER_MS,
  type PlaybackMetric,
  type TrackableVideo,
  ViewTracker,
} from "./metrics.ts";
import { assignSlots, planWindow, poolSize } from "./window.ts";

describe("preload window", () => {
  it("plays N, preloads N+1 and N+2, keeps N-1", () => {
    const plan = planWindow(5, 20);
    expect([...plan.roles.entries()].sort(([a], [b]) => a - b)).toEqual([
      [4, "keep"],
      [5, "play"],
      [6, "preload"],
      [7, "preload"],
    ]);
    expect(poolSize()).toBe(4);
  });

  it("clips at the ends of the feed", () => {
    expect([...planWindow(0, 2).roles.keys()].sort()).toEqual([0, 1]);
    expect(planWindow(3, 3).roles.size).toBe(0);
  });

  it("without preloading only the active video holds an element", () => {
    expect([...planWindow(5, 20, { ahead: 0, behind: 0 }).roles.keys()]).toEqual([5]);
  });

  it("recycles slots: items still in the window keep their element (no reload)", () => {
    const first = assignSlots([null, null, null, null], planWindow(0, 10)); // 0 play, 1-2 preload
    expect(first.filter((i) => i !== null).sort()).toEqual([0, 1, 2]);

    const next = assignSlots(first, planWindow(1, 10)); // swipe: 0 keep, 1 play, 2-3 preload
    first.forEach((index, slot) => {
      if (index !== null && [0, 1, 2].includes(index)) expect(next[slot]).toBe(index);
    });
    expect(next.filter((i) => i !== null).sort()).toEqual([0, 1, 2, 3]);

    const far = assignSlots(next, planWindow(8, 10)); // jump: everything is replaced
    expect(far.filter((i) => i !== null).sort()).toEqual([7, 8, 9]);
  });
});

/** An EventTarget with the few video properties the tracker reads. */
class FakeVideo extends EventTarget implements TrackableVideo {
  currentTime = 0;
  duration = 10;
  paused = true;
  seeking = false;
  fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }
  at(time: number): void {
    this.currentTime = time;
    this.fire("timeupdate");
  }
}

function track(preloaded = true) {
  const video = new FakeVideo();
  const metrics: PlaybackMetric[] = [];
  let clock = 1000;
  const tracker = new ViewTracker(
    video,
    { videoId: "v1", sessionId: "s1", preloaded, trigger: "swipe", engine: "hls.js" },
    (metric) => metrics.push(metric),
    1000,
    () => clock,
  );
  return { video, metrics, tracker, advance: (ms: number) => (clock += ms) };
}

describe("ViewTracker", () => {
  it("measures time to first frame from activation", () => {
    const { video, metrics, advance } = track();
    advance(180);
    video.paused = false;
    video.fire("playing");
    expect(metrics).toEqual([
      {
        videoId: "v1",
        sessionId: "s1",
        type: "ttff",
        valueMs: 180,
        data: { preloaded: true, trigger: "swipe", engine: "hls.js" },
      },
    ]);
  });

  it("does not count a loop restart (a seek) as a rebuffer", () => {
    const { video, metrics, advance } = track();
    video.paused = false;
    video.fire("playing");
    video.seeking = true;
    video.fire("waiting");
    advance(300);
    video.seeking = false;
    video.fire("playing");
    expect(metrics.filter((m) => m.type === "rebuffer")).toEqual([]);
  });

  it("ignores waits too short to be seen", () => {
    const { video, metrics, advance } = track();
    video.paused = false;
    video.fire("playing");
    video.fire("waiting");
    advance(MIN_REBUFFER_MS - 1);
    video.fire("playing");
    expect(metrics.filter((m) => m.type === "rebuffer")).toEqual([]);
  });

  it("measures rebuffers after the first frame only", () => {
    const { video, metrics, advance } = track();
    video.fire("waiting"); // initial load, not a rebuffer
    video.paused = false;
    video.fire("playing");
    video.fire("waiting");
    advance(750);
    video.fire("playing");
    expect(metrics.filter((m) => m.type === "rebuffer")).toEqual([
      { videoId: "v1", sessionId: "s1", type: "rebuffer", valueMs: 750 },
    ]);
  });

  it("reports watch time and completion, counting a loop as complete", () => {
    const { video, metrics, tracker } = track();
    video.paused = false;
    video.fire("playing");
    for (let t = 1; t <= 10; t += 1) video.at(t);
    video.at(0.2); // looped
    video.at(2);
    tracker.end();
    const watch = metrics.find((m) => m.type === "watch");
    expect(watch?.valueMs).toBe(11800);
    expect(watch?.data).toEqual({ completion: 1, loops: 1 });
  });

  it("reports partial completion", () => {
    const { video, metrics, tracker } = track();
    video.paused = false;
    video.fire("playing");
    video.at(4);
    tracker.end();
    expect(metrics.find((m) => m.type === "watch")?.data).toEqual({ completion: 0.4, loops: 0 });
  });

  it("does not report a watch for a video that never started", () => {
    const { metrics, tracker } = track();
    tracker.end();
    expect(metrics).toEqual([]);
  });

  it("ignores ABR's initial level choice but reports later switches", () => {
    const { video, metrics, tracker } = track();
    tracker.qualitySwitch(240, 400_000);
    video.paused = false;
    video.fire("playing");
    tracker.qualitySwitch(720, 2_500_000);
    expect(metrics.filter((m) => m.type === "quality_switch").map((m) => m.data)).toEqual([
      { height: 720, bitrate: 2_500_000 },
    ]);
  });
});
