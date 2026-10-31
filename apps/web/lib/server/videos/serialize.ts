import type { Video } from "@reelplane/db";
import type { ObjectStorage } from "@reelplane/storage";

export interface PublicVideo {
  id: string;
  status: Video["status"];
  title: string | null;
  creatorId: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  failureReason: string | null;
  createdAt: string;
  readyAt: string | null;
  playback: {
    hlsUrl: string;
    posterUrl: string | null;
    placeholder: string | null;
  } | null;
}

/** The API representation of a video. Storage keys and upload internals never leave the server. */
export function serializeVideo(video: Video, storage: ObjectStorage): PublicVideo {
  const playable = video.status === "ready" && video.masterPlaylistKey;
  return {
    id: video.id,
    status: video.status,
    title: video.title,
    creatorId: video.creatorId,
    durationMs: video.durationMs,
    width: video.width,
    height: video.height,
    failureReason: video.failureReason,
    createdAt: video.createdAt.toISOString(),
    readyAt: video.readyAt?.toISOString() ?? null,
    playback:
      playable && video.masterPlaylistKey
        ? {
            hlsUrl: storage.publicUrl(video.masterPlaylistKey),
            posterUrl: video.posterKey ? storage.publicUrl(video.posterKey) : null,
            placeholder: video.placeholder,
          }
        : null,
  };
}
