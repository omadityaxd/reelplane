"use client";

import { uploadVideo } from "@reelplane/sdk-core";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { createDashboardUpload } from "../_actions/videos.ts";

type Status =
  | { kind: "idle" }
  | { kind: "uploading"; name: string; fraction: number }
  | { kind: "error"; message: string };

/** Reads a video's duration in the browser, so over-long files are refused before upload. */
function measureDurationMs(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (value: number | undefined) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () =>
      done(Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined);
    video.onerror = () => done(undefined); // e.g. MKV in Safari: the worker checks it anyway
    video.src = url;
  });
}

export function UploadButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function upload(file: File) {
    setStatus({ kind: "uploading", name: file.name, fraction: 0 });
    const session = await createDashboardUpload(projectId, {
      contentType: file.type || "video/mp4",
      sizeBytes: file.size,
      durationMs: await measureDurationMs(file),
      filename: file.name,
      title: file.name.replace(/\.[^.]+$/, "").slice(0, 200),
    });
    if (!session.ok) {
      setStatus({ kind: "error", message: session.error });
      return;
    }
    try {
      await uploadVideo({
        apiBaseUrl: window.location.origin,
        file,
        session: { videoId: session.videoId, token: session.token },
        onProgress: (progress) =>
          setStatus({ kind: "uploading", name: file.name, fraction: progress.fraction }),
      });
      setStatus({ kind: "idle" });
      router.push(`/dashboard/${projectId}/videos/${session.videoId}`);
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Upload failed.",
      });
    }
  }

  return (
    <div className="dash-row">
      <input
        ref={input}
        type="file"
        accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mkv"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      <button
        type="button"
        className="dash-button dash-button--primary"
        disabled={status.kind === "uploading"}
        onClick={() => input.current?.click()}
      >
        Upload a video
      </button>
      {status.kind === "uploading" && (
        <>
          <span className="dash-note" style={{ margin: 0 }}>
            {status.name}: {Math.round(status.fraction * 100)}%
          </span>
          <div className="dash-progress" style={{ width: 160 }}>
            <span style={{ width: `${status.fraction * 100}%` }} />
          </div>
        </>
      )}
      {status.kind === "error" && (
        <p className="dash-error" role="alert">
          {status.message}
        </p>
      )}
      <span className="dash-note" style={{ margin: 0 }}>
        Up to 60 s and 100 MB.
      </span>
    </div>
  );
}
