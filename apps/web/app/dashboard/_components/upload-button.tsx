"use client";

import { uploadVideo } from "@reelplane/sdk-core";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { DashboardUploadResult } from "../_actions/videos.ts";

type Status =
  | { kind: "idle" }
  | { kind: "uploading"; name: string; fraction: number }
  | { kind: "done"; name: string }
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

export interface UploadButtonProps {
  /** Server action that starts an upload session (checks who may upload, and where to). */
  start: (input: unknown) => Promise<DashboardUploadResult>;
  /** After the upload, go to `${donePath}/${videoId}`; without it, say it's processing. */
  donePath?: string;
  note?: string;
  /** Checked in the browser too, so an oversized file fails before anything is uploaded. */
  maxBytes?: number;
}

export function UploadButton({
  start,
  donePath,
  note,
  maxBytes = 100 * 1024 * 1024,
}: UploadButtonProps) {
  const maxMb = Math.floor(maxBytes / (1024 * 1024));
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function upload(file: File) {
    if (file.size > maxBytes) {
      setStatus({ kind: "error", message: `${file.name} is over the ${maxMb} MB limit.` });
      return;
    }
    setStatus({ kind: "uploading", name: file.name, fraction: 0 });
    const session = await start({
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
      if (donePath) {
        setStatus({ kind: "idle" });
        router.push(`${donePath}/${session.videoId}`);
      } else {
        setStatus({ kind: "done", name: file.name });
      }
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
      {status.kind === "done" && (
        <p role="status" style={{ margin: 0 }}>
          {status.name} uploaded. It appears at the top of the feed once processed (about a minute).
        </p>
      )}
      <span className="dash-note" style={{ margin: 0 }}>
        {note ?? `Up to 60 s and ${maxMb} MB.`}
      </span>
    </div>
  );
}
