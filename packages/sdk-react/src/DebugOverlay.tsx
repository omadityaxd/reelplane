"use client";

import {
  type DebugInfo,
  type FeedController,
  measureFps,
  measureStalls,
} from "@reelplane/sdk-core";
import { useEffect, useState } from "react";

const REFRESH_MS = 500;

function line(label: string, value: string | number | null | undefined): string {
  return `${label.padEnd(9)} ${value ?? "–"}`;
}

/** Live playback details of the active video (`<ReelFeed debug />`, e.g. via `?debug=1`). */
export function DebugOverlay({ controller }: { controller: FeedController }) {
  const [info, setInfo] = useState<DebugInfo | null>(null);

  useEffect(() => {
    let video: HTMLVideoElement | null = null;
    let stopFps: (() => void) | null = null;
    let stopStalls: (() => void) | null = null;
    const tick = () => {
      const active = controller.activeVideo();
      if (active !== video) {
        stopFps?.();
        stopStalls?.();
        video = active;
        stopFps = active ? measureFps(active) : null;
        stopStalls = active ? measureStalls(active) : null;
      }
      setInfo(controller.getDebugInfo());
    };
    tick();
    const timer = setInterval(tick, REFRESH_MS);
    return () => {
      clearInterval(timer);
      stopFps?.();
      stopStalls?.();
    };
  }, [controller]);

  if (!info) return null;
  const dropped =
    info.droppedFrames === null ? null : `${info.droppedFrames} / ${info.totalFrames ?? "?"}`;
  const text = [
    line("engine", info.engine),
    line("rendition", info.rendition),
    line("decoded", info.resolution),
    line("bitrate", info.bitrateKbps === null ? null : `${info.bitrateKbps} kbps`),
    line("fps", `${info.presentedFps ?? "–"} shown / ${info.sourceFps ?? "–"} encoded`),
    line("buffer", `${info.bufferAheadSeconds} s ahead (target ${info.bufferTarget})`),
    line("stalls", `${info.stalls} (${(info.stallMs / 1000).toFixed(1)} s total)`),
    line(
      "segment",
      info.lastSegmentMs === null
        ? null
        : `${info.lastSegmentMs} ms${info.lastSegmentKbps ? ` @ ${info.lastSegmentKbps} kbps` : ""}`,
    ),
    line("dropped", dropped),
    line("start", info.startQuality),
    line("network", info.estimateMbps === null ? "unknown" : `${info.estimateMbps} Mbps est.`),
    line("warming", info.warming ? "on (next video)" : "off"),
  ].join("\n");
  return (
    <pre className="rp-debug" aria-hidden="true">
      {text}
    </pre>
  );
}
