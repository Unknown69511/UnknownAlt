import { useQueries } from "@tanstack/react-query";
import { archiveOptions } from "./archive";
import { assembleGameTimeline } from "./gameHistoryData";
import type { GameRecord } from "./store";
import type { PublicGame } from "./types";

export function useGameTimelines(game: PublicGame | undefined, ids: number[], records: Record<number, GameRecord>, includeVisits: boolean) {
  const daily = useQueries({ queries: ids.map((id) => archiveOptions("gameDaily", id)) });
  const series = useQueries({ queries: ids.map((id) => archiveOptions("gameSeries", id)) });
  const archive = useQueries({ queries: ids.map((id) => archiveOptions("gameArchive", id)) });
  const hourly = useQueries({ queries: ids.map((id) => archiveOptions("gameHourly", id)) });
  const recent = useQueries({ queries: ids.map((id) => archiveOptions("gameRecent", id)) });
  const visits = useQueries({ queries: ids.map((id) => ({ ...archiveOptions("gameTotals", id), enabled: includeVisits })) });
  const requests = [...daily, ...series, ...archive, ...hourly, ...recent, ...(includeVisits ? visits : [])];
  return {
    requests,
    primaryVisits: visits[0],
    timelines: ids.map((id, index) => assembleGameTimeline({
      days: daily[index].data, totals: visits[index].data, stats: series[index].data, statsLong: archive[index].data,
      hourly: hourly[index].data, recent: recent[index].data, saved: records[id],
      created: id === game?.universeId ? game.created : undefined,
    })),
    providerUpdates: [series[0]?.data?.updates, archive[0]?.data?.updates],
  };
}
