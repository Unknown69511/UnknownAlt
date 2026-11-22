import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../../api";
import { toast } from "../../ui/Toast";

function cell(value: string | number) {
  if (typeof value === "number") return String(value);
  const safe = /^[\s]*[=+\-@]|^[\t\r\n]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export async function saveAnalyticsCsv(name: string, headers: string[], rows: (string | number)[][]) {
  const path = await save({ defaultPath: name, filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (!path) return;
  await api.creatorAnalyticsExport(path, [headers.join(","), ...rows.map((row) => row.map(cell).join(",")), ""].join("\r\n"));
  toast("Analytics CSV saved.");
}
