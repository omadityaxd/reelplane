"use client";

import { useTransition } from "react";
import { unhideDashboardVideo } from "../_actions/videos.ts";

export function UnhideVideo({ projectId, videoId }: { projectId: string; videoId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="dash-button"
      disabled={pending}
      onClick={() => startTransition(() => unhideDashboardVideo(projectId, videoId))}
    >
      Show in feeds again
    </button>
  );
}
