import {
  getVideo,
  type JobSummary,
  listJobs,
  listRenditions,
  type TimelineEvent,
  videoTimeline,
} from "@reelplane/db";
import { notFound } from "next/navigation";
import {
  badgeClass,
  formatBytes,
  formatDate,
  formatDuration,
  formatTime,
  statusTone,
} from "@/lib/dashboard/format.ts";
import { requireProject } from "@/lib/server/dashboard/session.ts";
import { appDeps } from "@/lib/server/routes.ts";
import { serializeVideo } from "@/lib/server/videos/serialize.ts";
import { DeleteVideo } from "../../../_components/delete-video.tsx";
import { LiveRefresh } from "../../../_components/live-refresh.tsx";
import { PreviewPlayer } from "../../../_components/preview-player.tsx";
import { UnhideVideo } from "../../../_components/unhide-video.tsx";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IN_PROGRESS = new Set(["uploading", "queued", "processing"]);

/** One timeline line per audit event: what happened, in words. */
function describeEvent(event: TimelineEvent): { text: string; tone: string } {
  const data = event.data as { attempt?: number; worker?: string; error?: string; reason?: string };
  switch (event.type) {
    case "video.created":
      return { text: "Upload started", tone: "info" };
    case "video.queued":
      return event.fromStatus === "uploading"
        ? { text: "Upload complete, waiting for a worker", tone: "info" }
        : { text: "Back in the queue", tone: "warn" };
    case "video.processing":
      return { text: "Processing", tone: "info" };
    case "video.ready":
      return { text: "Ready to play", tone: "ok" };
    case "video.failed":
      return { text: `Failed: ${data.reason ?? "unknown error"}`, tone: "bad" };
    case "video.deleted":
      return { text: "Deleted", tone: "neutral" };
    case "job.queued":
      return data.error
        ? { text: `Attempt ${data.attempt} failed: ${data.error}. Retrying.`, tone: "warn" }
        : { text: "Transcode job queued", tone: "info" };
    case "job.running":
      return {
        text: `Attempt ${data.attempt} started on ${data.worker ?? "a worker"}`,
        tone: "info",
      };
    case "job.succeeded":
      return { text: `Transcoded (attempt ${data.attempt})`, tone: "ok" };
    case "job.dead":
      return { text: `Gave up after attempt ${data.attempt}: ${data.error}`, tone: "bad" };
    case "job.cancelled":
      return { text: "Job cancelled", tone: "neutral" };
    default:
      return { text: event.type, tone: "neutral" };
  }
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  const start = events[0]?.createdAt.getTime() ?? 0;
  return (
    <ol className="dash-timeline">
      {events.map((event) => {
        const { text, tone } = describeEvent(event);
        return (
          <li key={event.id} data-tone={tone}>
            <div>{text}</div>
            <div className="when">
              {formatTime(event.createdAt)} · +{formatDuration(event.createdAt.getTime() - start)}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function JobDetails({ job }: { job: JobSummary }) {
  const metrics = job.metrics as {
    encodeMs?: number;
    speedRealtime?: number;
    source?: string;
    outputFps?: string;
    preset?: string;
  } | null;
  return (
    <table className="dash-table">
      <tbody>
        <tr>
          <th>Job</th>
          <td>
            <span className={badgeClass(job.state)}>{job.state}</span> attempt {job.attempts} of{" "}
            {job.maxAttempts}
          </td>
        </tr>
        {job.state === "running" && (
          <tr>
            <th>Progress</th>
            <td>
              <div className="dash-progress">
                <span style={{ width: `${job.progress}%` }} />
              </div>
              {job.progress}% on {job.worker}
            </td>
          </tr>
        )}
        {metrics?.encodeMs !== undefined && (
          <tr>
            <th>Encode</th>
            <td>
              {formatDuration(metrics.encodeMs)} ({metrics.speedRealtime?.toFixed(1)}× realtime,
              preset {metrics.preset})
            </td>
          </tr>
        )}
        {metrics?.source && (
          <tr>
            <th>Source</th>
            <td className="mono">
              {metrics.source} → {metrics.outputFps?.replace(/\/1$/, "")} fps
            </td>
          </tr>
        )}
        {job.lastError && (
          <tr>
            <th>Last error</th>
            <td className="dash-error">{job.lastError}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export default async function VideoPage({
  params,
}: {
  params: Promise<{ projectId: string; videoId: string }>;
}) {
  const { projectId, videoId } = await params;
  const { project } = await requireProject(projectId);
  if (!UUID.test(videoId)) notFound();
  const deps = appDeps();
  const video = await getVideo(deps.pool, project.id, videoId);
  if (!video) notFound();
  const [events, jobs, renditions] = await Promise.all([
    videoTimeline(deps.pool, project.id, video.id),
    listJobs(deps.pool, project.id, { videoId: video.id, limit: 1 }),
    listRenditions(deps.pool, project.id, video.id),
  ]);
  const playback = serializeVideo(video, deps.storage).playback;
  const job = jobs[0];

  return (
    <>
      <div className="dash-row dash-row--between">
        <div className="dash-row">
          <h2 style={{ margin: 0 }}>{video.title || video.originalFilename || "Untitled"}</h2>
          <span className={badgeClass(video.status)}>{video.status}</span>
          <LiveRefresh active={IN_PROGRESS.has(video.status)} />
        </div>
        {video.status !== "deleted" && <DeleteVideo projectId={project.id} videoId={video.id} />}
      </div>
      <p className="mono dash-note">{video.id}</p>
      {video.hiddenAt && (
        <div className="dash-secret dash-row dash-row--between" role="status">
          <span>
            Hidden from feeds since {formatDate(video.hiddenAt)}: three viewers reported it. Review
            it, then delete it or show it again.
          </span>
          <UnhideVideo projectId={project.id} videoId={video.id} />
        </div>
      )}
      <div className="dash-grid">
        <section className="dash-card">
          {playback ? (
            <PreviewPlayer src={playback.hlsUrl} poster={playback.posterUrl} />
          ) : (
            <p className="dash-empty">
              {statusTone(video.status) === "bad"
                ? video.failureReason
                : "The preview appears once the video is ready."}
            </p>
          )}
          <table className="dash-table">
            <tbody>
              <tr>
                <th>Duration</th>
                <td>{formatDuration(video.durationMs ?? video.declaredDurationMs)}</td>
              </tr>
              <tr>
                <th>Size</th>
                <td>
                  {formatBytes(video.sizeBytes)} · {video.contentType}
                </td>
              </tr>
              <tr>
                <th>Uploaded</th>
                <td>{formatDate(video.createdAt)}</td>
              </tr>
              {playback && (
                <tr>
                  <th>HLS</th>
                  <td className="mono" style={{ wordBreak: "break-all" }}>
                    {playback.hlsUrl}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
        <section className="dash-card">
          <h2>Processing timeline</h2>
          <Timeline events={events} />
          {job && <JobDetails job={job} />}
        </section>
      </div>
      {renditions.length > 0 && (
        <section className="dash-card dash-table-wrap">
          <h2>Renditions</h2>
          <table className="dash-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Resolution</th>
                <th className="num">Bitrate</th>
                <th className="num">fps</th>
                <th>Codecs</th>
              </tr>
            </thead>
            <tbody>
              {renditions.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td>
                    {r.width}×{r.height}
                  </td>
                  <td className="num">{r.bitrateKbps} kbps</td>
                  <td className="num">{r.fps ?? "–"}</td>
                  <td className="mono">{r.codecs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
