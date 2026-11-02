import { type JobState, listJobs } from "@reelplane/db";
import Link from "next/link";
import { badgeClass, formatDate, formatDuration } from "@/lib/dashboard/format.ts";
import { requireProject } from "@/lib/server/dashboard/session.ts";
import { appDeps } from "@/lib/server/routes.ts";
import { LiveRefresh } from "../../_components/live-refresh.tsx";

const STATES: JobState[] = ["queued", "running", "succeeded", "dead", "cancelled"];

export default async function JobsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ state?: string }>;
}) {
  const { project } = await requireProject((await params).projectId);
  const requested = (await searchParams).state;
  const state = STATES.find((s) => s === requested);
  const jobs = await listJobs(appDeps().pool, project.id, { state, limit: 100 });
  const base = `/dashboard/${project.id}`;
  const active = jobs.some((job) => job.state === "queued" || job.state === "running");

  return (
    <>
      <div className="dash-row" style={{ marginBottom: 12 }}>
        <Link
          className="dash-button"
          href={`${base}/jobs`}
          aria-current={!state ? "page" : undefined}
        >
          All
        </Link>
        {STATES.map((s) => (
          <Link
            key={s}
            className="dash-button"
            href={`${base}/jobs?state=${s}`}
            aria-current={state === s ? "page" : undefined}
          >
            {s}
          </Link>
        ))}
        <LiveRefresh active={active} />
      </div>
      {jobs.length === 0 ? (
        <p className="dash-empty">No jobs{state ? ` in state "${state}"` : ""}.</p>
      ) : (
        <section className="dash-card dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Video</th>
                <th>State</th>
                <th className="num">Attempts</th>
                <th>Progress / error</th>
                <th className="num">Took</th>
                <th>Queued</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <Link href={`${base}/videos/${job.videoId}`}>
                      {job.videoTitle || job.videoId.slice(0, 8)}
                    </Link>
                  </td>
                  <td>
                    <span className={badgeClass(job.state)}>{job.state}</span>
                  </td>
                  <td className="num">
                    {job.attempts}/{job.maxAttempts}
                  </td>
                  <td>
                    {job.state === "running" ? (
                      <div className="dash-row">
                        <div className="dash-progress">
                          <span style={{ width: `${job.progress}%` }} />
                        </div>
                        {job.progress}%
                      </div>
                    ) : job.lastError ? (
                      <span className="dash-error">{job.lastError}</span>
                    ) : job.state === "queued" && job.runAfter > new Date() ? (
                      <span className="dash-note">retry at {formatDate(job.runAfter)}</span>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td className="num">
                    {job.startedAt && job.finishedAt
                      ? formatDuration(job.finishedAt.getTime() - job.startedAt.getTime())
                      : "–"}
                  </td>
                  <td>{formatDate(job.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
