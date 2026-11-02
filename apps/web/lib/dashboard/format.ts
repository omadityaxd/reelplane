/** Display helpers shared by dashboard server and client components. */

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

const STATUS_TONES: Record<string, Tone> = {
  ready: "ok",
  succeeded: "ok",
  failed: "bad",
  dead: "bad",
  deleted: "neutral",
  cancelled: "neutral",
  processing: "info",
  running: "info",
  queued: "warn",
  pending: "warn",
  uploading: "warn",
};

export function statusTone(status: string): Tone {
  return STATUS_TONES[status] ?? "neutral";
}

export function badgeClass(status: string): string {
  const tone = statusTone(status);
  return tone === "neutral" ? "dash-badge" : `dash-badge dash-badge--${tone}`;
}

const dateTime = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDate(value: Date | string | null): string {
  return value ? dateTime.format(new Date(value)) : "–";
}

/** "12:03:04.512": the timeline is about seconds and milliseconds. */
export function formatTime(value: Date | string): string {
  const date = new Date(value);
  return `${date.toLocaleTimeString("en-GB")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatPercent(fraction: number | null, digits = 0): string {
  return fraction === null ? "–" : `${(fraction * 100).toFixed(digits)}%`;
}
