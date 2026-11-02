"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteDashboardVideo } from "../_actions/videos.ts";

/** Two-step delete (no browser confirm dialog): click, then confirm. */
export function DeleteVideo({ projectId, videoId }: { projectId: string; videoId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  if (!confirming) {
    return (
      <button
        type="button"
        className="dash-button dash-button--danger"
        onClick={() => setConfirming(true)}
      >
        Delete video
      </button>
    );
  }
  return (
    <span className="dash-row">
      <span>Delete for good? Its files are removed and webhooks get video.deleted.</span>
      <button
        type="button"
        className="dash-button dash-button--danger"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await deleteDashboardVideo(projectId, videoId);
            router.push(`/dashboard/${projectId}`);
          })
        }
      >
        Yes, delete
      </button>
      <button type="button" className="dash-button" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  );
}
