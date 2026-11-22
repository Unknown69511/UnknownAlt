import { fmtDate, fmtExact, fmtNum } from "../../i18n";
import { useId, useMemo, useState, type PointerEvent } from "react";

export type Sample = { at: number; value: number; observedAt?: number; source?: string };
export type Series = { label: string; points: Sample[]; dashed?: boolean };
type Interval = { from: number; to: number };
type Marker = { at: number; label: string };
type Props = Interval & { points: Sample[]; format: (value: number) => string; exact?: (value: number) => string;
  axis?: (value: number) => string; gap?: number; series?: Series[]; markers?: Marker[];
  size?: "large" | "compact"; utc?: boolean; loading?: boolean; onZoom?: (range: Interval) => void };

const width = 850;
const colors = ["currentColor", "#73b6ec", "#d998d7", "#7bbc9e", "#b5a1db"];
const axisValue = (value: number) => fmtNum(Math.abs(value) < 100 ? value : Math.round(value), { maximumFractionDigits: 1 });
const exactValue = (value: number) => fmtExact(value, { maximumFractionDigits: 8 });
const valid = (point: Sample) => Number.isFinite(point.at) && Number.isFinite(point.value);
const observationTime = (point: Sample) => fmtDate(point.observedAt ?? point.at, point.source?.includes("(UTC)")
  ? { dateStyle: "medium", timeZone: "UTC" } : { dateStyle: "medium", timeStyle: "medium" });

function runs(points: Sample[], gap: number) {
  const result: Sample[][] = [];
  for (const item of points) {
    const last = result.at(-1);
    if (!last || item.at - last.at(-1)!.at > gap) result.push([item]);
    else last.push(item);
  }
  return result;
}

export function groupHistoryMarkers(markers: Marker[], from: number, to: number, pixelPerTime: number) {
  const groups: { at: number; last: number; labels: string[] }[] = [];
  for (const item of [...markers].sort((a, b) => a.at - b.at)) {
    if (!Number.isFinite(item.at) || item.at < from || item.at > to) continue;
    const prior = groups.at(-1);
    if (prior && (item.at - prior.at) * pixelPerTime < 16) {
      prior.last = item.at;
      if (!prior.labels.includes(item.label)) prior.labels.push(item.label);
    } else groups.push({ at: item.at, last: item.at, labels: [item.label] });
  }
  return groups;
}

function nearest<T extends { at: number }>(points: T[], timestamp: number) {
  let low = 0, high = points.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (points[mid].at < timestamp) low = mid + 1;
    else high = mid;
  }
  return low > 0 && timestamp - points[low - 1].at < points[low].at - timestamp ? low - 1 : low;
}

export function HistoryChart({ points, from, to, format, exact = exactValue, axis = axisValue, gap = Infinity, series,
    markers, size, utc, loading, onZoom }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const shade = useId();
  const clip = useId();
  const compact = size === "compact";
  const height = size === "large" ? 280 : compact ? 78 : 166;
  const right = width - (compact ? 5 : 25);
  const top = compact ? 4 : 22;
  const floor = height - (compact ? 4 : 26);
  const duration = Math.max(1, to - from);
  const traces = useMemo(() => (series ?? [{ label: "", points }]).map((trace) => {
    const inRange = new Map(trace.points.filter((point) => valid(point) && point.at >= from && point.at <= to)
      .map((point) => [point.at, point]));
    return { ...trace, points: [...inRange.values()].sort((a, b) => a.at - b.at) };
  }), [points, series, from, to]);
  const all = useMemo(() => traces.flatMap((trace, index) => trace.points.map((point) => ({ ...point, index })))
    .sort((a, b) => a.at - b.at), [traces]);
  const { ceiling, bottom } = useMemo(() => all.reduce((extents, point) => ({
    ceiling: Math.max(extents.ceiling, point.value), bottom: Math.min(extents.bottom, point.value),
  }), { ceiling: 0, bottom: Infinity }), [all]);
  const spread = Math.max(ceiling - (all.length ? bottom : 0), ceiling * .025, 1);
  const max = ceiling + spread * .14;
  const min = all.length ? Math.max(0, bottom - spread * .15) : 0;
  const left = compact ? 5 : Math.min(230, Math.max(48, Math.max(axis(max).length, axis(min).length) * 9 + 13));
  const factor = (right - left) / duration;
  const x = (at: number) => left + (at - from) * factor;
  const y = (value: number) => floor - (floor - top) * (value - min) / (max - min);
  const curves = useMemo(() => traces.flatMap((trace, i) => runs(trace.points, gap).map((rows) => {
    const getX = (at: number) => left + (at - from) * factor;
    const getY = (value: number) => floor - (floor - top) * (value - min) / (max - min);
    const coordinates = rows.map((point) => [getX(point.at), getY(point.value)]);
    const curve = coordinates.map(([cx, cy], index) => {
      if (!index) return `M${cx.toFixed(2)},${cy.toFixed(2)}`;
      const [px, py] = coordinates[index - 1];
      const mid = ((px + cx) / 2).toFixed(2);
      return `C${mid},${py.toFixed(2)} ${mid},${cy.toFixed(2)} ${cx.toFixed(2)},${cy.toFixed(2)}`;
    }).join(" ");
    const [firstX, firstY] = coordinates[0];
    return { series: i, at: rows[0].at, count: rows.length, dashed: trace.dashed, curve,
      firstX, firstY, lastX: coordinates.at(-1)![0] };
  })), [traces, gap, from, left, factor, floor, top, min, max]);
  const markGroups = useMemo(() => groupHistoryMarkers(markers ?? [], from, to, factor), [markers, from, to, factor]);
  const hovered = selected != null && selected >= from && selected <= to && all.length > 0;
  const index = hovered ? nearest(all, selected) : all.length - 1;
  const focus = all[index];
  const simultaneous = hovered ? all.filter((point) => point.at === focus.at && point.index !== focus.index) : [];
  const pointerTime = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const fraction = (width * (event.clientX - bounds.left) / Math.max(1, bounds.width) - left) / (right - left);
    return from + duration * Math.min(1, Math.max(0, fraction));
  };
  const axisDate = (value: number) => fmtDate(value, {
    ...(utc ? { timeZone: "UTC" } : {}),
    ...(duration < 48 * 3_600_000 && !utc ? { hour: "numeric", minute: "2-digit" } :
      { month: "short", day: "numeric", ...(duration >= 340 * 86_400_000 ? { year: "numeric" } : {}) }),
  });
  return <div className={compact ? "analytics-chart compact" : "analytics-chart"}>
    {focus && (!compact || hovered) && <output className={compact ? "analytics-spark-readout" : "analytics-chart-readout"}>
      <strong title={exact(focus.value)}>{hovered ? exact(focus.value) : format(focus.value)}</strong>
      <span>{[traces[focus.index].label, observationTime(focus), focus.source].filter(Boolean).join(" · ")}</span>
      {simultaneous.map((point) => <span key={point.index}>{traces[point.index].label} · {exact(point.value)}</span>)}
    </output>}
    {!focus && !compact && <div className="analytics-chart-readout" role="status">
      {loading ? "Loading recorded history…" : "No records in this date range."}
    </div>}
    <svg viewBox={`0 0 ${width} ${height}`} className="analytics-svg" role="img"
      aria-label={compact ? "Recorded player trend" : "Historical metric chart"}
      onPointerLeave={() => { if (!drag) setSelected(null); }}
      onPointerDown={onZoom && all.length ? (event) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const start = pointerTime(event);
        setDrag({ start, end: start });
      } : undefined}
      onPointerMove={(event) => {
        const at = pointerTime(event);
        if (drag) setDrag({ ...drag, end: at });
        if (!all.length) return;
        const point = all[nearest(all, at)];
        setSelected(Math.abs(point.at - at) <= gap ? point.at : null);
      }}
      onPointerUp={(event) => {
        if (!drag) return;
        const end = pointerTime(event);
        if (Math.abs(end - drag.start) > duration * .02) onZoom?.({ from: Math.min(end, drag.start), to: Math.max(end, drag.start) });
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}>
      <defs>
        <clipPath id={clip}><rect x={left - 2} y={top - 4} width={right - left + 4} height={floor - top + 6} /></clipPath>
        <linearGradient id={shade} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity=".35" /><stop offset="100%" stopColor="currentColor" stopOpacity=".02" />
        </linearGradient>
      </defs>
      {!compact && [0, .25, .5, .75, 1].map((step) => {
        const value = min + (max - min) * step;
        return <g key={step}><line x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="currentColor" opacity=".18" />
          {!!all.length && <text x={left - 8} y={y(value) + 4} textAnchor="end" className="analytics-axis">{axis(value)}</text>}</g>;
      })}
      <g clipPath={`url(#${clip})`}>
        {curves.map((row) => {
          const stroke = colors[row.series % colors.length];
          return <g key={`${row.series}:${row.at}`} className="motion-safe:animate-[history-appear_250ms_ease-out]" data-history-series={row.series}>
            {row.series === 0 && row.count > 1 && <path d={`${row.curve} L${row.lastX},${floor} L${row.firstX},${floor} Z`} fill={`url(#${shade})`} />}
            <path d={row.curve} fill="none" stroke={stroke} strokeWidth={compact ? "1.25" : "2"}
              strokeDasharray={row.dashed ? "4 5" : undefined} vectorEffect="non-scaling-stroke" />
            {row.count === 1 && <circle cx={row.firstX} cy={row.firstY} r={compact ? 4 : 3} fill={stroke} />}
          </g>;
        })}
      </g>
      {!!all.length && markGroups.map((group) => {
        const position = x((group.at + group.last) / 2);
        return <g key={group.at} data-update-count={group.labels.length}>
          <title>{group.labels.join("\n")}</title>
          <line x1={position} x2={position} y1={top} y2={floor} stroke="currentColor" opacity=".55" strokeDasharray="3 4" />
          <circle cx={position} cy={top} r={5} fill="currentColor" />
          {group.labels.length > 1 && <text x={position} y={top - 8} textAnchor="middle" className="analytics-axis">{fmtNum(group.labels.length)}</text>}
        </g>;
      })}
      {!compact && [0, .25, .5, .75, 1].map((step) => {
        const value = from + duration * step;
        return <text key={step} x={x(value)} y={height - 6} textAnchor={step === 0 ? "start" : step === 1 ? "end" : "middle"}
          className="analytics-axis">{axisDate(value)}</text>;
      })}
      {drag && <rect x={x(Math.min(drag.start, drag.end))} y={top} width={Math.abs(x(drag.end) - x(drag.start))}
        height={floor - top} fill="currentColor" opacity=".16" />}
      {hovered && <g><line x1={x(focus.at)} x2={x(focus.at)} y1={top} y2={floor} stroke="currentColor" opacity=".5" />
        <circle cx={x(focus.at)} cy={y(focus.value)} r={compact ? 7 : 4} fill={colors[focus.index % colors.length]}>
          <title>{exact(focus.value)} · {observationTime(focus)}</title></circle></g>}
    </svg>
    {series && <ul className="flex flex-wrap gap-3 text-xs">{traces.map((trace, i) => <li key={`${i}:${trace.label}`}><span
      className="text-[var(--user-accent-text)]" style={{ color: colors[i % colors.length] === "currentColor" ? undefined : colors[i % colors.length] }}>●</span> {trace.label}{trace.points.length ? "" : " (no records)"}</li>)}</ul>}
    {!compact && all.length > 1 && <input aria-label="Select a data point" type="range" className="sr-only focus:not-sr-only" min={0}
      max={all.length - 1} value={index} onChange={(event) => setSelected(all[Number(event.target.value)].at)} />}
  </div>;
}
