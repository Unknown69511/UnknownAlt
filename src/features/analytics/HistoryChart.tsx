import { useState } from "react";

type Sample = { at: number; value: number };
type Series = { label: string; points: Sample[] };
type Props = { points: Sample[]; from: number; to: number; format: (value: number) => string; gap?: number; series?: Series[]; markers?: { at: number; label: string }[] };
const width = 680;
const height = 156;
const pad = 7;

const colors = ["currentColor", "#73b6ec", "#d998d7"];

export function HistoryChart({ points, from, to, format, gap, series, markers }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const traces = series ?? [{ label: "", points }];
  const all = series ? traces.flatMap((trace, index) => trace.points.map((point) => ({ ...point, index }))).sort((a, b) => a.at - b.at) : points.map((point) => ({ ...point, index: 0 }));
  if (!all.length) return <p className="text-sm text-fg-2 py-5">No observations in this date range.</p>;
  const selectedIndex = Math.min(selected ?? all.length - 1, all.length - 1);
  const focus = all[selectedIndex];
  const max = Math.max(0, ...all.map((point) => point.value));
  const min = Math.min(0, ...all.map((point) => point.value));
  const x = (at: number) => pad + (width - 2 * pad) * (at - from) / Math.max(1, to - from);
  const y = (value: number) => height - pad - (height - 2 * pad) * (value - min) / Math.max(Number.EPSILON, max - min);
  const path = (rows: Sample[]) => rows.map((point, i) =>
    `${i === 0 || (gap != null && point.at - rows[i - 1].at > gap) ? "M" : "L"}${x(point.at).toFixed(2)},${y(point.value).toFixed(2)}`,
  ).join(" ");
  const stamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  return <div className="space-y-2">
    <div className="flex justify-between gap-2 text-sm"><output>{[traces[focus.index].label, format(focus.value), stamp.format(focus.at)].filter(Boolean).join(" · ")}</output><span className="text-fg-2">Top {format(max)}</span></div>
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full rounded-lg border border-line text-[var(--user-accent-text)]"
      role="img" aria-label="Historical metric chart"
      onPointerMove={(e) => {
        const bounds = e.currentTarget.getBoundingClientRect();
        const timestamp = from + (to - from) * ((e.clientX - bounds.left) / bounds.width * width - pad) / (width - 2 * pad);
        setSelected(all.reduce((a, b, i) => Math.abs(b.at - timestamp) < Math.abs(all[a].at - timestamp) ? i : a, 0));
      }}>
      {[.25, .5, .75].map((level) => <line key={level} x1={pad} x2={width - pad} y1={height * level} y2={height * level} stroke="currentColor" opacity=".18" />)}
      {markers?.filter((mark) => mark.at >= from && mark.at <= to).map((mark) => <line key={mark.at} x1={x(mark.at)} x2={x(mark.at)} y1={pad} y2={height - pad} stroke="currentColor" strokeDasharray="4 4"><title>{mark.label}</title></line>)}
      {traces.map((trace, index) => <path key={index} d={path(trace.points)} fill="none" stroke={colors[index % colors.length]} strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
      {all.map((point, i) => (i === selectedIndex || traces[point.index].points.length <= 15) && <circle key={i} cx={x(point.at)} cy={y(point.value)} r={i === selectedIndex ? 4 : 2} fill={colors[point.index % colors.length]} />)}
    </svg>
    {series && <ul className="flex flex-wrap gap-3 text-xs">{series.map((trace, i) => <li key={trace.label}><span className="text-[var(--user-accent-text)]" style={{ color: colors[i % colors.length] === "currentColor" ? undefined : colors[i % colors.length] }}>●</span> {trace.label}{trace.points.length ? "" : " (no observations)"}</li>)}</ul>}
    {all.length > 1 && <input aria-label="Select an observed data point" type="range" className="w-full" min={0} max={all.length - 1} value={selectedIndex} onChange={(e) => setSelected(Number(e.target.value))} />}
  </div>;
}
