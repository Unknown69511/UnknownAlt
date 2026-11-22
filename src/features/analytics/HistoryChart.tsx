import { useMemo, useState } from "react";

export type Sample = { at: number; value: number; observedAt?: number };
export type Series = { label: string; points: Sample[]; dashed?: boolean };
type Props = { points: Sample[]; from: number; to: number; format: (value: number) => string; gap?: number; series?: Series[]; markers?: { at: number; label: string }[]; size?: "large" | "compact" };
const width = 680;
const pad = 7;

const colors = ["currentColor", "#73b6ec", "#d998d7", "#7bbc9e", "#9d9da7"];
const stamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

export function HistoryChart({ points, from, to, format, gap, series, markers, size }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const height = size === "large" ? 245 : size === "compact" ? 85 : 156;
  const traces = useMemo(() => series ?? [{ label: "", points }], [points, series]);
  const all = useMemo(() => traces.flatMap((trace, index) => trace.points.map((point) => ({ ...point, index }))).sort((a, b) => a.at - b.at), [traces]);
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
  return <div className="space-y-2">
    <div className={size === "compact" ? "text-xs text-fg-2" : "flex justify-between gap-2 text-sm"}><output>{[traces[focus.index].label, format(focus.value), stamp.format(focus.observedAt ?? focus.at)].filter(Boolean).join(" · ")}</output></div>
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full rounded-lg border border-line text-[var(--user-accent-text)]"
      role="img" aria-label="Historical metric chart"
      onPointerLeave={() => setSelected(null)}
      onPointerMove={(e) => {
        const bounds = e.currentTarget.getBoundingClientRect();
        const timestamp = from + (to - from) * ((e.clientX - bounds.left) / bounds.width * width - pad) / (width - 2 * pad);
        let low = 0;
        let high = all.length - 1;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (all[mid].at < timestamp) low = mid + 1;
          else high = mid;
        }
        setSelected(low > 0 && Math.abs(all[low - 1].at - timestamp) < Math.abs(all[low].at - timestamp) ? low - 1 : low);
      }}>
      {[.25, .5, .75].map((level) => <line key={level} x1={pad} x2={width - pad} y1={height * level} y2={height * level} stroke="currentColor" opacity=".18" />)}
      {markers?.filter((mark) => mark.at >= from && mark.at <= to).map((mark) => <line key={mark.at} x1={x(mark.at)} x2={x(mark.at)} y1={pad} y2={height - pad} stroke="currentColor" strokeDasharray="4 4"><title>{mark.label}</title></line>)}
      {selected != null && <line x1={x(focus.at)} x2={x(focus.at)} y1={pad} y2={height - pad} stroke="currentColor" opacity=".3" />}
      {traces.map((trace, index) => <path key={trace.label} d={path(trace.points)} fill="none" stroke={colors[index % colors.length]} strokeWidth="2" strokeDasharray={trace.dashed ? "4 5" : undefined} vectorEffect="non-scaling-stroke" className="motion-safe:animate-[history-appear_250ms_ease-out]" />)}
      {all.map((point, i) => (i === selectedIndex || traces[point.index].points.length <= 15) && <circle key={i} cx={x(point.at)} cy={y(point.value)} r={i === selectedIndex ? 4 : 2} fill={colors[point.index % colors.length]} />)}
    </svg>
    {series && <ul className="flex flex-wrap gap-3 text-xs">{series.map((trace, i) => <li key={trace.label}><span className="text-[var(--user-accent-text)]" style={{ color: colors[i % colors.length] === "currentColor" ? undefined : colors[i % colors.length] }}>●</span> {trace.label}{trace.points.length ? "" : " (no observations)"}</li>)}</ul>}
    {size !== "compact" && <div className="flex justify-between text-xs text-fg-2"><time>{stamp.format(from)}</time><time>{stamp.format(to)}</time></div>}
    {all.length > 1 && <input aria-label="Select an observed data point" type="range" className={size === "compact" ? "sr-only focus:not-sr-only" : "w-full"} min={0} max={all.length - 1} value={selectedIndex} onChange={(e) => setSelected(Number(e.target.value))} />}
  </div>;
}
