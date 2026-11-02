"use client";

import { PlaybackEngine } from "@reelplane/sdk-core";
import { useEffect, useRef } from "react";

/** Plays a ready video's HLS with the SDK's engine (native HLS on Apple, hls.js elsewhere). */
export function PreviewPlayer({ src, poster }: { src: string; poster: string | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const engine = new PlaybackEngine(video);
    void engine.load(src, "play");
    return () => engine.unload();
  }, [src]);
  return (
    <video
      ref={ref}
      className="dash-player"
      poster={poster ?? undefined}
      controls
      playsInline
      muted
    />
  );
}
