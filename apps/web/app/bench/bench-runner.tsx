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
  swipeToPlayMs: number | null;
  ttffMs: number | null;
  preloaded: boolean | null;
}

export interface BenchResult {
  mode: "preload" | "no-preload";
  done: boolean;
  swipes: number;
  samples: Sample[];
  p50: number | null;
  p95: number | null;
  mean: number | null;
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
  const values = samples
    .map((s) => s.swipeToPlayMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  return {
    mode,
    done,
    swipes,
    samples,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    mean: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null,
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
    swipes: Math.max(1, Number(params.get("swipes") ?? 25)),
    dwell: Math.max(0, Number(params.get("dwell") ?? 2000)),
    nonce: params.get("run") ?? Math.random().toString(36).slice(2),
  };
}

export function BenchRunner({ publishableKey }: { publishableKey: string }) {
  const [config, setConfig] = useState<ReturnType<typeof readConfig> | null>(null);
  useEffect(() => setConfig(readConfig()), []);
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
  const pending = useRef<{ index: number; swipedAt: number; timer: number } | null>(null);
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
    const timer = window.setTimeout(() => {
      if (pending.current?.index !== index) return;
      pending.current = null;
      if (!record({ index, swipeToPlayMs: null, ttffMs: null, preloaded: null })) swipe();
    }, TIMEOUT_MS);
    pending.current = { index, swipedAt: performance.now(), timer };
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
        const done = record({
          index: current.index,
          swipeToPlayMs: Math.round(paintedAt - current.swipedAt),
          ttffMs: metric.valueMs ?? null,
          preloaded: metric.data?.preloaded === true,
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
      urlTransform: (url: string) => `${url}${url.includes("?") ? "&" : "?"}bench=${config.nonce}`,
    }),
    [config.nonce],
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
        {result.p95 ?? "–"} ms · timeouts {result.timeouts}
        {result.done ? " · DONE" : ""}
      </output>
    </div>
  );
}
