export const STATUS_HOME = "https://status.roblox.com";
const page = "/pages/incident/59db90dbcdeb2f04dadcf16d/";
export type Service = { id: string; name: string; status: string; status_code: number; containers: Service[] };
export type Incident = { id: string; name: string; datetime_open: string; messages: { details: string; state: number; datetime: string }[] };
export type CurrentStatus = {
  status_overall: { status: string; status_code: number; updated: string };
  status: Service[];
  incidents: Incident[];
};
export type StatusResponse = { current: CurrentStatus | null; historyHtml: string | null; checkedAt: number };
export type PastIncident = { id: string; title: string; impact: string; date: string; details: string; resolved: boolean };

export const incidentUrl = (id: string) => /^[\da-f]{24}$/i.test(id) ? STATUS_HOME + page + id : STATUS_HOME;

export function incidentHistory(html: string): PastIncident[] {
  // The official archive provides HTML. Read its text from an inert template.
  const template = document.createElement("template");
  template.innerHTML = html;
  const incidents = new Map<string, PastIncident>();
  for (const link of template.content.querySelectorAll<HTMLAnchorElement>(`a[href^="${page}"]`)) {
    const id = link.getAttribute("href")?.slice(page.length) ?? "";
    const panel = link.closest(".panel");
    const title = link.textContent?.trim();
    if (!panel || !title || incidentUrl(id) === STATUS_HOME || incidents.has(id)) continue;
    const messages = Array.from(panel.querySelectorAll(".incident_update_status"));
    const latest = messages.at(-1)?.closest(".row");
    incidents.set(id, {
      id, title,
      impact: panel.querySelector(".status_description")?.textContent?.trim() ?? "",
      date: latest?.querySelector(".incident_time")?.textContent?.trim() ?? "",
      details: latest?.querySelector(".incident_message_details")?.textContent?.trim() ?? "",
      resolved: messages.at(-1)?.textContent?.trim().toLowerCase() === "resolved",
    });
    if (incidents.size >= 40) break;
  }
  return [...incidents.values()];
}
