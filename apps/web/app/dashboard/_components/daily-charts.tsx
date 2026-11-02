"use client";

import { useState } from "react";

export interface Day {
  day: string;
  views: number;
  ttffP50: number | null;
  ttffP95: number | null;
}

const WIDTH = 480;
const HEIGHT = 200;
const PAD = { top: 16, right: 92, bottom: 24, left: 48 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;
const MAX_BAR = 24;
const BAR_RADIUS = 4;
const MIN_LABEL_GAP = 14;

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 2.5, 5, 10]) if (value <= factor * step) return factor * step;
  return 10 * step;
}

function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Column with a 4px rounded top, square on the baseline. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(BAR_RADIUS, h, w / 2);
  const base = y + h;
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

function Axes({ max, days }: { max: number; days: Day[] }) {
  const step = PLOT_W / days.length;
  const every = Math.ceil(days.length / 7);
  return (
    <>
      {[0, 0.5, 1].map((t) => {
        const y = PAD.top + PLOT_H * (1 - t);
        return (
          <g key={t}>
            <line className="grid" x1={PAD.left} x2={PAD.left + PLOT_W} y1={y} y2={y} />
            <text x={PAD.left - 6} y={y + 4} textAnchor="end">
              {Math.round(max * t).toLocaleString("en")}
            </text>
          </g>
        );
      })}
      {days.map((d, i) =>
        i % every === 0 ? (
          <text key={d.day} x={PAD.left + step * (i + 0.5)} y={HEIGHT - 6} textAnchor="middle">
            {shortDay(d.day)}
          </text>
        ) : null,
      )}
    </>
  );
}

/** Views per day: one series, so the title names it and there is no legend. */
function ViewsChart({ days }: { days: Day[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...days.map((d) => d.views)));
  const step = PLOT_W / days.length;
  const barW = Math.min(MAX_BAR, step * 0.6);
  const hovered = hover === null ? null : days[hover];
  return (
    <div className="dash-chart-box">
      <svg
        className="dash-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Views per day"
      >
        <Axes max={max} days={days} />
        {days.map((d, i) => {
          const h = (d.views / max) * PLOT_H;
          const x = PAD.left + step * i + (step - barW) / 2;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus readout; the table view carries the same values
            <g
              key={d.day}
              tabIndex={0}
              aria-label={`${shortDay(d.day)}: ${d.views} views`}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            >
              {/* Hit target: the whole day column, bigger than the bar. */}
              <rect
                x={PAD.left + step * i}
                y={PAD.top}
                width={step}
                height={PLOT_H}
                fill="transparent"
              />
              {h > 0 && <path className="bar" d={columnPath(x, PAD.top + PLOT_H - h, barW, h)} />}
            </g>
          );
        })}
      </svg>
      {hovered && hover !== null && (
        <div
          className="dash-tooltip"
          style={{
            left: `${((PAD.left + step * (hover + 0.5)) / WIDTH) * 100}%`,
            top: `${(PAD.top / HEIGHT) * 100}%`,
          }}
        >
          <strong>{hovered.views.toLocaleString("en")}</strong> views · {shortDay(hovered.day)}
        </div>
      )}
    </div>
  );
}

const SERIES = [
  { key: "ttffP50", label: "p50", className: "s1", color: "var(--series-1)" },
  { key: "ttffP95", label: "p95", className: "s2", color: "var(--series-2)" },
] as const;

/** Time to first frame, p50 and p95: two lines on one axis (both are milliseconds). */
function TtffChart({ days }: { days: Day[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = days.flatMap((d) => [d.ttffP50, d.ttffP95]).filter((v): v is number => v !== null);
  const max = niceMax(Math.max(0, ...values));
  const step = PLOT_W / days.length;
  const x = (i: number) => PAD.left + step * (i + 0.5);
  const y = (v: number) => PAD.top + PLOT_H * (1 - v / max);

  const paths = SERIES.map((series) => {
    let d = "";
    let pen = false;
    days.forEach((day, i) => {
      const v = day[series.key];
      if (v === null) {
        pen = false; // a day without data is a gap, not a zero
        return;
      }
      d += `${pen ? "L" : "M"}${x(i)},${y(v)}`;
      pen = true;
    });
    const lastIndex = days.findLastIndex((day) => day[series.key] !== null);
    return { series, d, lastIndex };
  });
  const hovered = hover === null ? null : days[hover];
  // End labels that would overlap are dropped (legend + tooltip + table still carry the values).
  const endYs = paths.map(({ series, lastIndex }) => {
    const v = lastIndex >= 0 ? days[lastIndex]?.[series.key] : null;
    return v == null ? null : y(v);
  });
  const [a, b] = endYs;
  const showEndLabels = a == null || b == null || Math.abs(a - b) >= MIN_LABEL_GAP;

  return (
    <div className="dash-chart-box">
      <div className="dash-legend">
        {SERIES.map((s) => (
          <span key={s.key}>
            <span className="dash-key" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <svg
        className="dash-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Time to first frame per day, p50 and p95"
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const px = ((event.clientX - box.left) / box.width) * WIDTH;
          const i = Math.floor((px - PAD.left) / step);
          setHover(i >= 0 && i < days.length ? i : null);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <Axes max={max} days={days} />
        {hover !== null && (
          <line
            className="crosshair"
            x1={x(hover)}
            x2={x(hover)}
            y1={PAD.top}
            y2={PAD.top + PLOT_H}
          />
        )}
        {paths.map(({ series, d, lastIndex }) => {
          const last = lastIndex >= 0 ? days[lastIndex]?.[series.key] : null;
          return (
            <g key={series.key}>
              <path className={`line ${series.className}`} d={d} />
              {last != null && (
                <>
                  <circle
                    className="dot"
                    cx={x(lastIndex)}
                    cy={y(last)}
                    r={4}
                    fill={series.color}
                  />
                  {showEndLabels && (
                    <text className="label" x={x(lastIndex) + 10} y={y(last) + 4}>
                      {series.label} {Math.round(last)} ms
                    </text>
                  )}
                </>
              )}
            </g>
          );
        })}
      </svg>
      {hovered && hover !== null && (
        <div
          className="dash-tooltip"
          style={{ left: `${(x(hover) / WIDTH) * 100}%`, top: `${(PAD.top / HEIGHT) * 100}%` }}
        >
          <div>{shortDay(hovered.day)}</div>
          {SERIES.map((s) => (
            <div key={s.key}>
              <span className="dash-key" style={{ background: s.color }} />
              <strong>
                {hovered[s.key] === null ? "–" : `${Math.round(hovered[s.key] ?? 0)} ms`}
              </strong>{" "}
              {s.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DailyCharts({ days }: { days: Day[] }) {
  return (
    <div className="dash-grid">
      <section className="dash-card">
        <h2>Views per day</h2>
        <ViewsChart days={days} />
      </section>
      <section className="dash-card">
        <h2>Time to first frame (ms)</h2>
        <TtffChart days={days} />
      </section>
    </div>
  );
}
