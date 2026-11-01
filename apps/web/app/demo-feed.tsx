"use client";

import { ReelFeed } from "@reelplane/sdk-react";
import { useEffect, useState } from "react";

export function DemoFeed({ publishableKey }: { publishableKey: string }) {
  // `?debug=1` shows live playback details over the feed (for testing on real phones).
  const [debug, setDebug] = useState(false);
  useEffect(() => setDebug(new URLSearchParams(window.location.search).get("debug") === "1"), []);
  return (
    <ReelFeed
      publishableKey={publishableKey}
      feed="latest"
      debug={debug}
      aria-label="Reelplane demo feed"
    />
  );
}
