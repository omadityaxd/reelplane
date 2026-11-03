import { listVideos } from "@reelplane/db";
import Link from "next/link";
import { badgeClass, formatBytes, formatDate, formatDuration } from "@/lib/dashboard/format.ts";
import { requireProject } from "@/lib/server/dashboard/session.ts";
import { appDeps } from "@/lib/server/routes.ts";
import { serializeVideo } from "@/lib/server/videos/serialize.ts";
import { createDashboardUpload } from "../_actions/videos.ts";
import { UploadButton } from "../_components/upload-button.tsx";

const PAGE_SIZE = 25;

export default async function VideosPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { project } = await requireProject((await params).projectId);
  const { cursor } = await searchParams;
  const deps = appDeps();
  let page: Awaited<ReturnType<typeof listVideos>>;
  try {
    page = await listVideos(deps.pool, { projectId: project.id, limit: PAGE_SIZE, cursor });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    page = await listVideos(deps.pool, { projectId: project.id, limit: PAGE_SIZE });
  }
  const base = `/dashboard/${project.id}`;

  return (
    <>
      <section className="dash-card">
        <UploadButton
          start={createDashboardUpload.bind(null, project.id)}
          donePath={`${base}/videos`}
        />
      </section>
      {page.videos.length === 0 ? (
        <p className="dash-empty">No videos yet. Upload one, or use the API.</p>
      ) : (
        <section className="dash-card dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th aria-label="Poster" />
                <th>Title</th>
                <th>Status</th>
                <th className="num">Duration</th>
                <th className="num">Size</th>
                <th>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {page.videos.map((video) => {
                const poster = serializeVideo(video, deps.storage).playback?.posterUrl;
                return (
                  <tr key={video.id}>
                    <td>
                      {poster ? (
                        // biome-ignore lint/performance/noImgElement: storage URLs, no image optimiser
                        <img className="dash-thumb" src={poster} alt="" loading="lazy" />
                      ) : (
                        <span className="dash-thumb" />
                      )}
                    </td>
                    <td>
                      <Link href={`${base}/videos/${video.id}`}>
                        {video.title || video.originalFilename || "Untitled"}
                      </Link>
                      <div className="mono dash-note" style={{ margin: 0 }}>
                        {video.id.slice(0, 8)}
                      </div>
                    </td>
                    <td>
                      <span className={badgeClass(video.status)}>{video.status}</span>
                    </td>
                    <td className="num">{formatDuration(video.durationMs)}</td>
                    <td className="num">{formatBytes(video.sizeBytes)}</td>
                    <td>{formatDate(video.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      <div className="dash-row">
        {cursor && (
          <Link className="dash-button" href={base}>
            ← Newest
          </Link>
        )}
        {page.nextCursor && (
          <Link className="dash-button" href={`${base}?cursor=${page.nextCursor}`}>
            Older →
          </Link>
        )}
      </div>
    </>
  );
}
