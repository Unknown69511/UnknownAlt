import { useState } from "react";

type Sample = { at: number; value: number };
type Props = { points: Sample[]; from: number; to: number; format: (value: number) => string; gap?: number };
const width = 680;
const height = 156;
const pad = 7;

export function HistoryChart({ points, from, to, format, gap }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  if (!points.length) return <p className="text-sm text-fg-2 py-5">No observations in this date range.</p>;
  const selectedIndex = Math.min(selected ?? points.length - 1, points.length - 1);
  const focus = points[selectedIndex];
  const max = Math.max(0, ...points.map((point) => point.value));
  const min = Math.min(0, ...points.map((point) => point.value));
  const x = (at: number) => pad + (width - 2 * pad) * (at - from) / Math.max(1, to - from);
  const y = (value: number) => height - pad - (height - 2 * pad) * (value - min) / Math.max(Number.EPSILON, max - min);
  const path = points.map((point, i) =>
    `${i === 0 || (gap != null && point.at - points[i - 1].at > gap) ? "M" : "L"}${x(point.at).toFixed(2)},${y(point.value).toFixed(2)}`,
  ).join(" ");
  const stamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  return <div className="space-y-2">
    <div className="flex justify-between gap-2 text-sm"><output>{format(focus.value)} · {stamp.format(focus.at)}</output><span className="text-fg-2">Top {format(max)}</span></div>
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full rounded-lg border border-line text-[var(--user-accent-text)]"
      role="img" aria-label="Historical metric chart"
      onPointerMove={(e) => {
        const bounds = e.currentTarget.getBoundingClientRect();
        const timestamp = from + (to - from) * ((e.clientX - bounds.left) / bounds.width * width - pad) / (width - 2 * pad);
        setSelected(points.reduce((a, b, i) => Math.abs(b.at - timestamp) < Math.abs(points[a].at - timestamp) ? i : a, 0));
      }}>
      {[.25, .5, .75].map((level) => <line key={level} x1={pad} x2={width - pad} y1={height * level} y2={height * level} stroke="currentColor" opacity=".18" />)}
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {points.map((point, i) => (i === selectedIndex || points.length <= 15) && <circle key={i} cx={x(point.at)} cy={y(point.value)} r={i === selectedIndex ? 4 : 2} fill="currentColor" />)}
    </svg>
    {points.length > 1 && <input aria-label="Select an observed data point" type="range" className="w-full" min={0} max={points.length - 1} value={selectedIndex} onChange={(e) => setSelected(Number(e.target.value))} />}
  </div>;
}
