import { fmtDate } from "../../i18n";
import { DAY } from "./archive";

export type TimeWindow = { from: number; to: number };

function clamp(start: number, width: number, outer: TimeWindow): TimeWindow {
  const length = Math.min(width, outer.to - outer.from);
  const from = Math.min(Math.max(start, outer.from), outer.to - length);
  return { from, to: from + length };
}

export function Timeline({ bounds, viewing, update, minWidth, utc }: {
  bounds: TimeWindow; viewing: TimeWindow; update: (value: TimeWindow) => void; minWidth: number; utc?: boolean;
}) {
  const max = Math.max(0, bounds.to - bounds.from);
  const width = Math.min(max, viewing.to - viewing.from);
  if (max <= minWidth || width <= 0) return null;
  const selectable = Math.max(0, max - width);
  const offset = Math.min(selectable, Math.max(0, viewing.from - bounds.from));
  const zoom = (next: number) => {
    const length = Math.min(max, Math.max(minWidth, next));
    update(clamp((viewing.from + viewing.to - length) / 2, length, bounds));
  };
  const display = (at: number) => fmtDate(at, { dateStyle: "medium", ...(utc ? { timeZone: "UTC" } : width < 2 * DAY ? { timeStyle: "short" } : {}) });
  return <div className="analytics-timeline">
    <div className="analytics-toolbar">
      <button type="button" className="btn btn-sm" disabled={width <= minWidth} onClick={() => zoom(width / 2)}>Zoom in</button>
      <button type="button" className="btn btn-sm" disabled={width >= max} onClick={() => zoom(width * 2)}>Zoom out</button>
      <button type="button" className="btn btn-sm" disabled={offset <= 0} onClick={() => update(clamp(viewing.from - width * .8, width, bounds))}>Earlier</button>
      <button type="button" className="btn btn-sm" disabled={offset >= selectable} onClick={() => update(clamp(viewing.from + width * .8, width, bounds))}>Later</button>
      <span className="text-xs text-fg-2">{display(viewing.from)} – {display(viewing.to)}</span>
    </div>
    {selectable > 0 && <label className="analytics-timeline-scroll"><span>Scroll timeline</span>
      <input type="range" min="0" max={selectable} step={Math.max(1, Math.floor(selectable / 1000))}
        value={offset} aria-valuetext={display(viewing.from)} onChange={(e) => update(clamp(bounds.from + Number(e.target.value), width, bounds))} />
    </label>}
  </div>;
}
