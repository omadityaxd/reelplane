"use client";

import { type PlaybackMetric, ReelFeed } from "@reelplane/sdk-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Swipe-to-play benchmark. Opens the bench feed, then repeatedly: waits for the active video's
 * first painted frame, lets it play for `dwell` ms, and swipes to the next one. Swipe-to-play =
 * time from the swipe to the next video's first painted frame.
 *
 * Query: ?preload=1|0 &swipes=25 &dwell=2000. Every run adds a unique `bench=<nonce>` to all
 * media URLs so neither mode benefits from the HTTP cache of an earlier run.
 */
interface Sample {
  index: number;
  /** Swipe → first painted frame, wall clock. */
  swipeToPlayMs: number | null;
  /** The same minus the time the page was hidden: what the statistics use. */
  visibleMs: number | null;
  ttffMs: number | null;
  preloaded: boolean | null;
  /** The target video at the moment of the swipe: why a slow swipe was slow. */
  atSwipe: TargetState | null;
  /** What happened between the swipe and the frame. */
  why: SwipeDiagnostics | null;
  /** Hidden at some point, or autoplay refused: not a clean measurement of the player. */
  flagged: boolean;
}

interface SwipeDiagnostics {
  /** The page was hidden (app switched, screen locked) at the moment of the swipe. */
  hiddenAtSwipe: boolean;
  /** Time the page spent hidden between the swipe and the first frame. */
  hiddenMs: number;
  /** Swipe → the player's first play() on the target; null: it never called play(). */
  playCalledMs: number | null;
  /** Swipe → that play() settling; null: still pending when the frame came (or never called). */
  playSettledMs: number | null;
  /** "resolved", "pending", "not called", or "rejected: <error name>". */
  playOutcome: string;
  /** play() was refused with NotAllowedError (Low Power Mode, a hidden page, no gesture). */
  autoplayBlocked: boolean;
}

/**
 * Bench-only instrumentation: every HTMLMediaElement.play() call (on which feed index, when, and
 * how it settled) and every stretch of time the page spent hidden.
 */
interface PlayCall {
  index: string | undefined;
  at: number;
  settledAt: number | null;
  outcome: string;
}
const playCalls: PlayCall[] = [];
const hiddenStretches: [number, number][] = [];
let hiddenSince: number | null = null;

function instrument(): () => void {
  const original = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
    const call: PlayCall = {
      index: this.dataset.index,
      at: performance.now(),
      settledAt: null,
      outcome: "pending",
    };
    playCalls.push(call);
    const promise = original.call(this);
    promise.then(
      () => {
        call.settledAt = performance.now();
        call.outcome = "resolved";
      },
      (error: unknown) => {
        call.settledAt = performance.now();
        call.outcome = `rejected: ${error instanceof DOMException ? error.name : "error"}`;
      },
    );
    return promise;
  };
  const onVisibility = () => {
    const now = performance.now();
    if (document.hidden) hiddenSince ??= now;
    else if (hiddenSince !== null) {
      hiddenStretches.push([hiddenSince, now]);
      hiddenSince = null;
    }
  };
  if (document.hidden) hiddenSince = performance.now();
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    HTMLMediaElement.prototype.play = original;
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

function hiddenBetween(start: number, end: number): number {
  const stretches: [number, number][] =
    hiddenSince === null ? hiddenStretches : [...hiddenStretches, [hiddenSince, end]];
  return stretches.reduce(
    (total, [from, to]) => total + Math.max(0, Math.min(to, end) - Math.max(from, start)),
    0,
  );
}

function diagnose(
  index: number,
  swipedAt: number,
  end: number,
  hiddenAtSwipe: boolean,
): SwipeDiagnostics {
  const calls = playCalls.filter((c) => c.index === String(index) && c.at >= swipedAt);
  const call = calls[0];
  const settled = call?.settledAt != null && call.settledAt <= end ? call.settledAt : null;
  return {
    hiddenAtSwipe,
    hiddenMs: Math.round(hiddenBetween(swipedAt, end)),
    playCalledMs: call ? Math.round(call.at - swipedAt) : null,
    playSettledMs: settled === null ? null : Math.round(settled - swipedAt),
    playOutcome: call ? (settled === null ? "pending" : call.outcome) : "not called",
    autoplayBlocked: calls.some((c) => c.outcome === "rejected: NotAllowedError"),
  };
}

function isFlagged(why: SwipeDiagnostics): boolean {
  return why.hiddenAtSwipe || why.hiddenMs > 0 || why.autoplayBlocked;
}

interface TargetState {
  /** HTMLMediaElement.readyState (4 = enough data to play through). */
  readyState: number;
  /** Seconds buffered from its current position. */
  bufferedAheadS: number;
  /** Whether it had played before (i.e. the warmer got to it). */
  warmed: boolean;
}

/** Snapshot of the pool element serving `index` (the swipe target), if it has one. */
function targetState(index: number): TargetState | null {
  const video = document.querySelector<HTMLVideoElement>(`video.rp-video[data-index="${index}"]`);
  if (!video) return null;
  let bufferedAheadS = 0;
  for (let i = 0; i < video.buffered.length; i += 1) {
    if (video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i))
      bufferedAheadS = video.buffered.end(i) - video.currentTime;
  }
  return {
    readyState: video.readyState,
    bufferedAheadS: Math.round(bufferedAheadS * 10) / 10,
    warmed: video.played.length > 0,
  };
}

const SLOWEST_SHOWN = 3;

export interface BenchResult {
  mode: "preload" | "no-preload";
  done: boolean;
  swipes: number;
  samples: Sample[];
  /** Over visible time (hidden time subtracted), every completed swipe. */
  p50: number | null;
  p95: number | null;
  mean: number | null;
  /** Swipes that were hidden at some point or had autoplay refused. */
  flagged: number;
  /** p50/p95 over the swipes that were not flagged. */
  clean: { p50: number | null; p95: number | null; n: number };
  timeouts: number;
  /** First video: activation → first frame (the SDK's TTFF metric). */
  initialTtffMs: number | null;
  /** First video: navigation start → first frame (page load + feed request + startup). */
  pageLoadToFirstFrameMs: number | null;
  userAgent: string;
}

interface InitialTiming {
  ttffMs: number | null;
  pageLoadMs: number | null;
}

declare global {
  interface Window {
    __reelplaneBench?: BenchResult;
  }
}

const TIMEOUT_MS = 20_000;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? null;
}

function summarise(
  mode: BenchResult["mode"],
  swipes: number,
  samples: Sample[],
  done: boolean,
  initial: InitialTiming = { ttffMs: null, pageLoadMs: null },
): BenchResult {
  const visible = (list: Sample[]) =>
    list
      .map((s) => s.visibleMs)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
  const values = visible(samples);
  const clean = visible(samples.filter((s) => !s.flagged));
  return {
    mode,
    done,
    swipes,
    samples,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    mean: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null,
    flagged: samples.filter((s) => s.flagged).length,
    clean: { p50: percentile(clean, 50), p95: percentile(clean, 95), n: clean.length },
    timeouts: samples.filter((s) => s.swipeToPlayMs === null).length,
    initialTtffMs: initial.ttffMs,
    pageLoadToFirstFrameMs: initial.pageLoadMs,
    userAgent: navigator.userAgent,
  };
}

function readConfig() {
  const params = new URLSearchParams(window.location.search);
  return {
    preload: params.get("preload") !== "0",
    warm: params.get("warm") !== "0",
    swipes: Math.max(1, Number(params.get("swipes") ?? 25)),
    dwell: Math.max(0, Number(params.get("dwell") ?? 2000)),
    nonce: params.get("run") ?? Math.random().toString(36).slice(2),
  };
}

export function BenchRunner({ publishableKey }: { publishableKey: string }) {
  const [config, setConfig] = useState<ReturnType<typeof readConfig> | null>(null);
  useEffect(() => {
    // Before the feed mounts, so the player's first play() is already observed.
    const restore = instrument();
    setConfig(readConfig());
    return restore;
  }, []);
  if (!config) return null;
  return <Bench publishableKey={publishableKey} config={config} />;
}

function Bench({
  publishableKey,
  config,
}: {
  publishableKey: string;
  config: ReturnType<typeof readConfig>;
}) {
  const mode = config.preload ? "preload" : "no-preload";
  const [result, setResult] = useState<BenchResult>(() =>
    summarise(mode, config.swipes, [], false),
  );
  const samples = useRef<Sample[]>([]);
  const pending = useRef<{
    index: number;
    swipedAt: number;
    timer: number;
    atSwipe: TargetState | null;
    hiddenAtSwipe: boolean;
  } | null>(null);
  const activeIndex = useRef(0);
  const finished = useRef(false);
  const initial = useRef<InitialTiming>({ ttffMs: null, pageLoadMs: null });

  const publish = useCallback(
    (done: boolean) => {
      const next = summarise(mode, config.swipes, [...samples.current], done, initial.current);
      window.__reelplaneBench = next;
      setResult(next);
    },
    [mode, config.swipes],
  );

  const record = useCallback(
    (sample: Sample) => {
      samples.current.push(sample);
      const done = samples.current.length >= config.swipes;
      publish(done);
      if (done) finished.current = true;
      return done;
    },
    [config.swipes, publish],
  );

  const swipe = useCallback(() => {
    if (finished.current) return;
    const scroller = document.querySelector<HTMLElement>(".rp-scroller");
    if (!scroller) return;
    const index = activeIndex.current + 1;
    const atSwipe = targetState(index);
    const timer = window.setTimeout(() => {
      if (pending.current?.index !== index) return;
      pending.current = null;
      const why = diagnose(index, swipedAt, performance.now(), hiddenAtSwipe);
      const timedOut: Sample = {
        index,
        swipeToPlayMs: null,
        visibleMs: null,
        ttffMs: null,
        preloaded: null,
        atSwipe,
        why,
        flagged: isFlagged(why),
      };
      if (!record(timedOut)) swipe();
    }, TIMEOUT_MS);
    const swipedAt = performance.now();
    const hiddenAtSwipe = document.hidden;
    pending.current = { index, swipedAt, timer, atSwipe, hiddenAtSwipe };
    scroller.scrollBy({ top: scroller.clientHeight, behavior: "instant" });
  }, [record]);

  const onMetric = useCallback(
    (metric: PlaybackMetric) => {
      if (metric.type !== "ttff" || finished.current) return;
      const paintedAt = performance.now();
      const current = pending.current;
      if (metric.data?.trigger === "initial") {
        // performance.now() is measured from navigation start.
        initial.current = { ttffMs: metric.valueMs ?? null, pageLoadMs: Math.round(paintedAt) };
        publish(false);
      }
      if (metric.data?.trigger === "swipe" && current) {
        window.clearTimeout(current.timer);
        pending.current = null;
        const why = diagnose(current.index, current.swipedAt, paintedAt, current.hiddenAtSwipe);
        const swipeToPlayMs = Math.round(paintedAt - current.swipedAt);
        const done = record({
          index: current.index,
          swipeToPlayMs,
          visibleMs: Math.max(0, swipeToPlayMs - why.hiddenMs),
          ttffMs: metric.valueMs ?? null,
          preloaded: metric.data?.preloaded === true,
          atSwipe: current.atSwipe,
          why,
          flagged: isFlagged(why),
        });
        if (done) return;
      }
      window.setTimeout(swipe, config.dwell);
    },
    [config.dwell, publish, record, swipe],
  );

  const controllerOptions = useMemo(
    () => ({
      sendMetrics: false, // keep benchmark traffic out of the project's analytics
      warm: config.warm,
      urlTransform: (url: string) => `${url}${url.includes("?") ? "&" : "?"}bench=${config.nonce}`,
    }),
    [config.nonce, config.warm],
  );

  return (
    <div style={{ display: "grid", gridTemplateRows: "1fr auto", height: "100dvh" }}>
      <ReelFeed
        publishableKey={publishableKey}
        feed="latest"
        preload={config.preload}
        pageSize={30}
        controllerOptions={controllerOptions}
        onMetric={onMetric}
        onActiveChange={(_item, index) => {
          activeIndex.current = index;
        }}
        debug={new URLSearchParams(window.location.search).get("debug") === "1"}
        aria-label="Benchmark feed"
      />
      <output
        id="bench-status"
        style={{
          font: "13px ui-monospace, monospace",
          padding: "8px 12px",
          background: "#111",
          color: "#eee",
        }}
      >
        {mode}: {result.samples.length}/{config.swipes} swipes · p50 {result.p50 ?? "–"} ms · p95{" "}
        {result.p95 ?? "–"} ms (visible time) · timeouts {result.timeouts} · flagged{" "}
        {result.flagged}
        {result.done ? " · DONE" : ""}
        {result.done && result.flagged > 0 && (
          <div>
            clean ({result.clean.n} unflagged): p50 {result.clean.p50 ?? "–"} ms · p95{" "}
            {result.clean.p95 ?? "–"} ms
          </div>
        )}
        {result.done && <SlowestSwipes samples={result.samples} />}
      </output>
    </div>
  );
}

/** The slowest swipes and the state of their target at swipe time (readable on a phone). */
function SlowestSwipes({ samples }: { samples: Sample[] }) {
  const slowest = [...samples]
    .sort((a, b) => (b.swipeToPlayMs ?? Infinity) - (a.swipeToPlayMs ?? Infinity))
    .slice(0, SLOWEST_SHOWN);
  return (
    <>
      {slowest.map((s) => (
        <div key={s.index}>
          {s.flagged ? "⚑ " : ""}swipe {s.index}: {s.swipeToPlayMs ?? "timeout"} ms
          {s.why && s.why.hiddenMs > 0 ? ` (hidden ${s.why.hiddenMs} ms)` : ""} · play(){" "}
          {s.why?.playOutcome ?? "–"}
          {s.why?.playCalledMs != null ? ` called +${s.why.playCalledMs}` : ""}
          {s.why?.playSettledMs != null ? ` settled +${s.why.playSettledMs} ms` : ""}
          {s.why?.autoplayBlocked ? " · autoplay blocked" : ""}
          {s.why?.hiddenAtSwipe ? " · hidden at swipe" : ""} · ready {s.atSwipe?.readyState ?? "–"}{" "}
          · buffered {s.atSwipe?.bufferedAheadS ?? "–"} s · warmed{" "}
          {s.atSwipe ? (s.atSwipe.warmed ? "yes" : "no") : "–"}
        </div>
      ))}
    </>
  );
}
