import { dailyPlayback, playbackStats } from "@reelplane/db";
import { formatDuration, formatPercent } from "@/lib/dashboard/format.ts";
import { requireProject } from "@/lib/server/dashboard/session.ts";
import { appDeps } from "@/lib/server/routes.ts";
import { DailyCharts } from "../../_components/daily-charts.tsx";

const DAYS = 14;
const WEEK_HOURS = 24 * 7;

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="dash-stat" title={hint}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

export default async function AnalyticsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { project } = await requireProject((await params).projectId);
  const pool = appDeps().pool;
  const [week, days] = await Promise.all([
    playbackStats(pool, project.id, WEEK_HOURS),
    dailyPlayback(pool, project.id, DAYS),
  ]);
  const views = days.slice(-7).reduce((sum, d) => sum + d.views, 0);

  return (
    <>
      <p className="dash-note">
        From the player SDK's playback events (last 7 days for the numbers, {DAYS} days for the
        charts, UTC). Benchmark runs don't send events.
      </p>
      <div className="dash-stats">
        <Stat
          label="Views"
          value={views.toLocaleString("en")}
          hint="Videos watched (a view ends on swipe or leave)"
        />
        <Stat
          label="Sessions"
          value={week.sessions.toLocaleString("en")}
          hint="Distinct player sessions"
        />
        <Stat
          label="Time to first frame p50"
          value={formatDuration(week.ttffP50)}
          hint="Activation to first painted frame"
        />
        <Stat
          label="Time to first frame p95"
          value={formatDuration(week.ttffP95)}
          hint="95th percentile"
        />
        <Stat
          label="Rebuffers per view"
          value={week.rebufferRate === null ? "–" : week.rebufferRate.toFixed(2)}
          hint="Playback stalls of 100 ms or more, excluding seeks"
        />
        <Stat
          label="Average completion"
          value={formatPercent(week.completionRate)}
          hint="Share of each video watched, capped at 100%"
        />
      </div>
      <DailyCharts days={days} />
      <details className="dash-card">
        <summary>Table view</summary>
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Day (UTC)</th>
                <th className="num">Views</th>
                <th className="num">TTFF p50</th>
                <th className="num">TTFF p95</th>
                <th className="num">Rebuffers / view</th>
                <th className="num">Completion</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  <td className="num">{d.views}</td>
                  <td className="num">{formatDuration(d.ttffP50)}</td>
                  <td className="num">{formatDuration(d.ttffP95)}</td>
                  <td className="num">
                    {d.rebufferRate === null ? "–" : d.rebufferRate.toFixed(2)}
                  </td>
                  <td className="num">{formatPercent(d.completionRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
