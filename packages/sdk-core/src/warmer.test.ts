import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Warmer } from "./warmer.ts";

/** Just enough of a <video> for the warmer: counts warm-up plays. */
function fakeVideo(play: () => Promise<void> = async () => undefined) {
  const video = {
    readyState: 4,
    currentTime: 0,
    muted: false,
    paused: true,
    plays: 0,
    async play() {
      video.plays += 1;
      await play();
      video.paused = false;
    },
    pause() {
      video.paused = true;
    },
    addEventListener() {},
  };
  return video;
}

describe("Warmer", () => {
  let hidden = false;
  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    vi.stubGlobal("document", {
      get hidden() {
        return hidden;
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not warm while the page is hidden, and resumes when it is visible again", async () => {
    hidden = true;
    const video = fakeVideo();
    const warmer = new Warmer();
    warmer.target(video as unknown as HTMLVideoElement);
    await vi.advanceTimersByTimeAsync(20_000); // five warm-up intervals in a background tab
    expect(video.plays).toBe(0);
    expect(warmer.isActive()).toBe(false);

    hidden = false;
    await vi.advanceTimersByTimeAsync(4_100);
    expect(video.plays).toBe(1);
    expect(video.paused).toBe(true); // one frame, then paused again
    expect(video.muted).toBe(true);
    warmer.stop();
  });

  it("re-warms at once on request (the page came back), but never twice at the same time", async () => {
    let finishPlay: () => void = () => undefined;
    let holdNext = false;
    const video = fakeVideo(
      () =>
        new Promise<void>((resolve) => {
          if (holdNext) finishPlay = resolve;
          else resolve();
        }),
    );
    const warmer = new Warmer();
    warmer.target(video as unknown as HTMLVideoElement);
    await vi.advanceTimersByTimeAsync(200);
    expect(video.plays).toBe(1);

    warmer.rewarm(); // well before the 4 s interval
    await vi.advanceTimersByTimeAsync(200);
    expect(video.plays).toBe(2);

    holdNext = true;
    warmer.rewarm(); // starts a warm-up that stays in flight…
    await vi.advanceTimersByTimeAsync(10);
    warmer.rewarm(); // …so this one must not start another
    await vi.advanceTimersByTimeAsync(10);
    expect(video.plays).toBe(3);
    finishPlay();
    warmer.stop();
  });

  it("keeps warming after a refused warm-up play()", async () => {
    let refuse = true;
    const video = fakeVideo(async () => {
      if (refuse) throw new DOMException("refused", "NotAllowedError");
    });
    const warmer = new Warmer();
    warmer.target(video as unknown as HTMLVideoElement);
    await vi.advanceTimersByTimeAsync(10);
    expect(video.plays).toBe(1);
    expect(warmer.isActive()).toBe(false);

    refuse = false;
    await vi.advanceTimersByTimeAsync(4_100);
    expect(video.plays).toBe(2);
    expect(warmer.isActive()).toBe(true);
    warmer.stop();
  });
});
