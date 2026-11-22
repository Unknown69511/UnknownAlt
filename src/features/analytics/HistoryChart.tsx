import { useId, useMemo, useState, type PointerEvent } from "react";

export type Sample = { at: number; value: number; observedAt?: number; source?: string };
export type Series = { label: string; points: Sample[]; dashed?: boolean };
type Interval = { from: number; to: number };
type Props = Interval & { points: Sample[]; format: (value: number) => string; gap?: number; series?: Series[];
  markers?: { at: number; label: string }[]; size?: "large" | "compact"; onZoom?: (range: Interval) => void };

const width = 850;
const colors = ["currentColor", "#73b6ec", "#d998d7", "#7bbc9e", "#b5a1db"];
const stamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const short = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function runs(points: Sample[], gap: number) {
  const result: Sample[][] = [];
  for (const item of points) {
    const last = result.at(-1);
    if (!last || item.at - last.at(-1)!.at > gap) result.push([item]);
    else last.push(item);
  }
  return result;
}

export function HistoryChart({ points, from, to, format, gap = Infinity, series, markers, size, onZoom }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const shade = useId();
  const compact = size === "compact";
  const height = size === "large" ? 280 : compact ? 78 : 166;
  const left = compact ? 5 : 47;
  const right = width - (compact ? 5 : 25);
  const top = compact ? 4 : 19;
  const floor = height - (compact ? 4 : 26);
  const traces = useMemo(() => series ?? [{ label: "", points }], [points, series]);
  const all = useMemo(() => traces.flatMap((trace, index) => trace.points.map((point) => ({ ...point, index })))
    .filter((point) => point.at >= from && point.at <= to).sort((a, b) => a.at - b.at), [traces, from, to]);
  if (!all.length) return <p className="analytics-chart-empty text-sm text-fg-2" role="status">No records in this date range.</p>;
  const index = Math.min(selected ?? all.length - 1, all.length - 1);
  const focus = all[index];
  const simultaneous = selected == null ? [] : all.filter((point) => point.at === focus.at && point.index !== focus.index);
  const ceiling = Math.max(...all.map((point) => point.value));
  const bottom = Math.min(...all.map((point) => point.value));
  const spread = Math.max(ceiling - bottom, ceiling * .025, 1);
  const max = ceiling + spread * .14;
  const min = Math.max(0, bottom - spread * .15);
  const x = (at: number) => left + (right - left) * (at - from) / Math.max(1, to - from);
  const y = (value: number) => floor - (floor - top) * (value - min) / (max - min);
  const path = (rows: Sample[]) => rows.map((point, i) => {
    const cx = x(point.at);
    const cy = y(point.value);
    if (!i) return `M${cx.toFixed(2)},${cy.toFixed(2)}`;
    const previous = rows[i - 1];
    const mid = ((x(previous.at) + cx) / 2).toFixed(2);
    return `C${mid},${y(previous.value).toFixed(2)} ${mid},${cy.toFixed(2)} ${cx.toFixed(2)},${cy.toFixed(2)}`;
  }).join(" ");
  const pointerTime = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const fraction = (width * (event.clientX - bounds.left) / bounds.width - left) / (right - left);
    return from + (to - from) * Math.min(1, Math.max(0, fraction));
  };
  return <div className={compact ? "analytics-chart compact" : "analytics-chart"}>
    {(!compact || selected != null) && <output className={compact ? "analytics-spark-readout" : "analytics-chart-readout"}>
      <strong>{format(focus.value)}</strong>
      <span>{[traces[focus.index].label, stamp.format(focus.observedAt ?? focus.at), focus.source].filter(Boolean).join(" · ")}</span>
      {simultaneous.map((point) => <span key={point.index}>{traces[point.index].label} · {format(point.value)}</span>)}
    </output>}
    <svg viewBox={`0 0 ${width} ${height}`} className="analytics-svg" role="img"
      aria-label={compact ? "Recorded player trend" : "Historical metric chart"}
      onPointerLeave={() => { if (!drag) setSelected(null); }}
      onPointerDown={onZoom ? (event) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const start = pointerTime(event);
        setDrag({ start, end: start });
      } : undefined}
      onPointerMove={(event) => {
        const at = pointerTime(event);
        if (drag) setDrag({ ...drag, end: at });
        let low = 0, high = all.length - 1;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (all[mid].at < at) low = mid + 1;
          else high = mid;
        }
        setSelected(low > 0 && Math.abs(all[low - 1].at - at) < Math.abs(all[low].at - at) ? low - 1 : low);
      }}
      onPointerUp={(event) => {
        if (!drag) return;
        const end = pointerTime(event);
        if (Math.abs(end - drag.start) > (to - from) * .025) onZoom?.({ from: Math.min(end, drag.start), to: Math.max(end, drag.start) });
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}>
      <defs><linearGradient id={shade} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="currentColor" stopOpacity=".35" /><stop offset="100%" stopColor="currentColor" stopOpacity=".02" />
      </linearGradient></defs>
      {!compact && [0, .25, .5, .75, 1].map((step) => {
        const value = min + (max - min) * step;
        return <g key={step}><line x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="currentColor" opacity=".18" />
          <text x={left - 8} y={y(value) + 4} textAnchor="end" className="analytics-axis">{short.format(value)}</text></g>;
      })}
      {traces.map((trace, i) => runs(trace.points.filter((point) => point.at >= from && point.at <= to), gap).map((rows) => {
        const curve = path(rows);
        const stroke = colors[i % colors.length];
        return <g key={`${i}:${rows[0].at}`} className="motion-safe:animate-[history-appear_250ms_ease-out]">
          {i === 0 && rows.length > 1 && <path d={`${curve} L${x(rows.at(-1)!.at)},${floor} L${x(rows[0].at)},${floor} Z`} fill={`url(#${shade})`} />}
          <path d={curve} fill="none" stroke={stroke} strokeWidth={compact ? "1.25" : "2"}
            strokeDasharray={trace.dashed ? "4 5" : undefined} vectorEffect="non-scaling-stroke" />
          {rows.length === 1 && <circle cx={x(rows[0].at)} cy={y(rows[0].value)} r={compact ? 4 : 3} fill={stroke} />}
        </g>;
      }))}
      {markers?.filter((mark) => mark.at >= from && mark.at <= to).map((mark) => <line key={`${mark.at}:${mark.label}`}
        x1={x(mark.at)} x2={x(mark.at)} y1={top} y2={floor} stroke="currentColor" opacity=".8" strokeDasharray="3 4"><title>{mark.label}</title></line>)}
      {!compact && [0, .25, .5, .75, 1].map((step) => {
        const value = from + (to - from) * step;
        return <text key={step} x={x(value)} y={height - 6} textAnchor={step === 0 ? "start" : step === 1 ? "end" : "middle"}
          className="analytics-axis">{to - from < 48 * 3_600_000 ? time.format(value) : date.format(value)}</text>;
      })}
      {drag && <rect x={x(Math.min(drag.start, drag.end))} y={top} width={Math.abs(x(drag.end) - x(drag.start))}
        height={floor - top} fill="currentColor" opacity=".16" />}
      {selected != null && <g><line x1={x(focus.at)} x2={x(focus.at)} y1={top} y2={floor} stroke="currentColor" opacity=".5" />
        <circle cx={x(focus.at)} cy={y(focus.value)} r={compact ? 7 : 4} fill={colors[focus.index % colors.length]}><title>{format(focus.value)} · {stamp.format(focus.at)}</title></circle></g>}
    </svg>
    {series && <ul className="flex flex-wrap gap-3 text-xs">{series.map((trace, i) => <li key={`${i}:${trace.label}`}><span
      className="text-[var(--user-accent-text)]" style={{ color: colors[i % colors.length] === "currentColor" ? undefined : colors[i % colors.length] }}>●</span> {trace.label}{trace.points.length ? "" : " (no records)"}</li>)}</ul>}
    {!compact && all.length > 1 && <input aria-label="Select a data point" type="range" className="sr-only focus:not-sr-only" min={0}
      max={all.length - 1} value={index} onChange={(event) => setSelected(Number(event.target.value))} />}
  </div>;
}
