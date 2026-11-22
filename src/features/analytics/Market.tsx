import { fmtDate, fmtNum } from "../../i18n";
import { useMemo, useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { Icon } from "../../ui/Icon";
import { count, percent } from "../discover/catalog";
import { HistoryChart } from "./HistoryChart";
import { Platform, Source } from "./Platform";
import { monthlyEstimate, Revenue, RevenueAssumptions, type EstimateValue } from "./revenue";
import { useAnalyticsStore } from "./store";
import {
  DAY, ROBLOX_CHARTS, STATS, WATCH, archiveOptions, at, charts, gameId, growthBetween, measurements,
  number, players, thumb, useArchive, type MarketGame, type Portfolio, type Studio,
} from "./archive";

export const sections = ["Overview", "Studios", "Top Earners", "Games", "Rising", "Trends", "Genres", "Charts",
  "New Games", "New Highs", "Calendar", "Watchlist", "My Games"] as const;
export type Section = typeof sections[number];
type Select = (id: number) => void;
type Go = (section: Section, filter?: string) => void;
type ChartName = typeof charts[number][0];

const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const printed = (value: number | null) => value == null ? "Unavailable" : fmtNum(value);
const gameGenre = (game: MarketGame) => game.genre ?? game.genreL1 ?? "";
const gameMaker = (game: MarketGame) => game.creatorName ?? game.creator;

export function AnalyticsCard({ title, description, action, children, className = "" }: {
  title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section className={`panel analytics-market-card ${className}`}>
    <header className="analytics-panel-heading"><div><h2>{title}</h2>{description && <p className="text-sm text-fg-2">{description}</p>}</div>{action}</header>
    {children}
  </section>;
}

function More({ children = "See all", onClick }: { children?: string; onClick: () => void }) {
  return <button className="btn btn-sm" onClick={onClick}>{children}<span aria-hidden>›</span></button>;
}

type FeedbackQuery = { isPending: boolean; isError: boolean; refetch: () => unknown };
function Feedback({ query, empty, label }: { query: FeedbackQuery; empty: boolean; label: string }) {
  if (query.isError) return <p className="analytics-feedback" role="status">Could not refresh {label}. {empty ? "" : "Showing saved records. "}
    <button className="btn btn-sm" onClick={() => void query.refetch()}>Retry</button></p>;
  if (query.isPending) return <p className="analytics-feedback analytics-loading" role="status">Loading {label}…</p>;
  return empty ? <p className="analytics-feedback" role="status">No {label} are available.</p> : null;
}

function Image({ game }: { game: MarketGame }) {
  const [failed, setFailed] = useState<string>();
  const src = thumb(game);
  return src && src !== failed ? <img loading="lazy" src={src} alt="" width={42} height={42} className="analytics-game-icon" onError={() => setFailed(src)} />
    : <span className="analytics-game-icon analytics-icon-placeholder" aria-hidden><Icon name="play" /></span>;
}

export function RankedGames({ games, select, position = true, detail }: {
  games: MarketGame[]; select: Select; position?: boolean; detail?: (game: MarketGame) => ReactNode;
}) {
  const ids = new Set<number>();
  return <ol className="analytics-ranked">
    {games.filter((game) => {
      const id = gameId(game);
      if (!id || ids.has(id)) return false;
      ids.add(id);
      return true;
    }).map((game, index) => <li key={gameId(game)}>
      <button className="analytics-rank-row" onClick={() => select(gameId(game))}>
        {position && <span className="analytics-rank">{index + 1}</span>}
        <Image game={game} />
        <span className="analytics-rank-text"><strong title={game.name}>{game.name || `Game ${gameId(game)}`}</strong>
          <small>{[gameMaker(game), gameGenre(game)].filter(Boolean).join(" · ")}</small></span>
        <span className="analytics-rank-value">{detail ? detail(game) : <><strong>{printed(players(game))}</strong><small>Playing</small></>}</span>
      </button>
    </li>)}
  </ol>;
}

function Records({ select, go }: { select: Select; go?: Go }) {
  const query = useArchive("records");
  const [top, setTop] = useState(false);
  const data = (top ? query.data?.peaks : query.data?.recent) ?? [];
  return <AnalyticsCard title="Games at a New High" description="Highest readings observed by RobloxGameStats."
    action={go ? <More onClick={() => go("New Highs")} /> : <div className="analytics-segment" role="group" aria-label="Record view">
      <button aria-pressed={!top} onClick={() => setTop(false)}>Recent records</button><button aria-pressed={top} onClick={() => setTop(true)}>Archive peaks</button>
    </div>}>
    <Feedback query={query} empty={!data.length} label="player records" />
    <RankedGames games={go ? data.slice(0, 5) : data} select={select} detail={(game) => <>
      <strong>{printed(number(game.peakAll))}</strong><small>{at(game.recordAt) != null ? date.format(at(game.recordAt)!) : "Recorded peak"}</small></>} />
    <Source url={`${STATS}/docs/api`}>RobloxGameStats</Source>
  </AnalyticsCard>;
}

function NewGames({ select, go }: { select: Select; go?: Go }) {
  const query = useArchive("newGames");
  const data = query.data?.games ?? [];
  return <AnalyticsCard title="Top New Games This Week" description="Recent releases tracked by RobloxGameStats."
    action={go && <More onClick={() => go("New Games")} />}>
    <Feedback query={query} empty={!data.length} label="recent releases" />
    <RankedGames games={go ? data.slice(0, 5) : data} select={select} detail={(game) => <><strong>{printed(players(game))}</strong>
      <small>{at(game.createdAt) != null ? `Created ${date.format(at(game.createdAt)!)}` : "Playing"}</small></>} />
    <Source url={`${STATS}/docs/api`}>RobloxGameStats</Source>
  </AnalyticsCard>;
}

type Activity = { game: MarketGame; kind: "Update" | "Player record" | "Visit milestone"; when: number; value?: number | null };
function useActivity() {
  const records = useArchive("records");
  const market = useArchive("games");
  const newGames = useArchive("newGames");
  const saved = useAnalyticsStore().records;
  const activity = useMemo(() => {
    const events = new Map<string, Activity>();
    const add = (game: MarketGame, kind: Activity["kind"], whenValue: unknown, value?: number | null) => {
      const when = at(whenValue);
      const id = gameId(game);
      if (when == null || !id) return;
      const key = [id, kind, Math.floor(when / 60_000)].join(":");
      if (!events.has(key)) events.set(key, { game, kind, when, value });
    };
    for (const game of records.data?.recent ?? []) add(game, "Player record", game.recordAt, number(game.peakAll));
    for (const game of records.data?.milestones ?? []) add(game, "Visit milestone", game.milestoneAt, number(game.milestone));
    for (const game of [...market.data ?? [], ...newGames.data?.games ?? [], ...records.data?.recent ?? [], ...records.data?.peaks ?? []]) {
      add(game, "Update", game.robloxUpdatedAt ?? game.robloxUpdated);
    }
    for (const row of Object.values(saved)) {
      const game = row.game;
      for (const update of row.updates) add({ universeId: game.universeId, name: game.name, iconUrl: game.icon ?? undefined, genre: game.genre ?? undefined }, "Update", update);
    }
    return [...events.values()].sort((a, b) => b.when - a.when);
  }, [records.data, market.data, newGames.data, saved]);
  return { activity, pending: records.isPending && market.isPending && newGames.isPending,
    error: records.isError || market.isError || newGames.isError,
    retry: () => { void records.refetch(); void market.refetch(); void newGames.refetch(); } };
}

function Events({ events, select }: { events: Activity[]; select: Select }) {
  return <ol className="analytics-events">{events.map(({ game, kind, when, value }) =>
    <li key={`${gameId(game)}:${kind}:${when}`}><button className="analytics-event" onClick={() => select(gameId(game))}>
      <Image game={game} /><span className="analytics-rank-text"><strong title={game.name}>{game.name || `Game ${gameId(game)}`}</strong>
        <small>{kind}{value == null ? "" : ` · ${count(value)} ${kind === "Player record" ? "players" : "visits"}`}</small></span>
      <time className="text-xs text-fg-2" dateTime={new Date(when).toISOString()}>{date.format(when)}</time>
    </button></li>)}</ol>;
}

function Pulse({ select, go }: { select: Select; go: Go }) {
  const { activity, pending, error, retry } = useActivity();
  return <AnalyticsCard title="Pulse" description="Updates, milestones, and new player records." action={<More onClick={() => go("Calendar")} />} className="analytics-pulse">
    <Feedback query={{ isPending: pending, isError: error, refetch: retry }} empty={!activity.length} label="activity records" />
    <Events events={activity.slice(0, 8)} select={select} />
  </AnalyticsCard>;
}

function Calendar({ select }: { select: Select }) {
  const [month, setMonth] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const [filter, setFilter] = useState("All activity");
  const { activity, pending, error, retry } = useActivity();
  const next = new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime();
  const events = activity.filter((entry) => entry.when >= month.getTime() && entry.when < next && (filter === "All activity" || entry.kind === filter));
  const days = new Map<string, Activity[]>();
  for (const event of events) {
    const key = date.format(event.when);
    const group = days.get(key) ?? [];
    group.push(event);
    days.set(key, group);
  }
  return <AnalyticsCard title="Activity Calendar" description="Recorded game updates and milestones from the loaded feeds and your tracked games.">
    <div className="analytics-toolbar">
      <button className="btn btn-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>Previous month</button>
      <strong>{month.toLocaleDateString(undefined, { year: "numeric", month: "long" })}</strong>
      <button className="btn btn-sm" disabled={next > Date.now()} onClick={() => setMonth(new Date(next))}>Next month</button>
      <select className="field" aria-label="Calendar activity type" value={filter} onChange={(event) => setFilter(event.target.value)}>
        {["All activity", "Update", "Player record", "Visit milestone"].map((choice) => <option key={choice}>{choice}</option>)}</select>
    </div>
    <Feedback query={{ isPending: pending, isError: error, refetch: retry }} empty={!events.length} label="calendar entries for this month" />
    {[...days].map(([day, rows]) => <section key={day}><h3 className="analytics-day">{day}</h3><Events events={rows} select={select} /></section>)}
  </AnalyticsCard>;
}

function Rising({ select, go }: { select: Select; go?: Go }) {
  const query = useArchive("officialChart", undefined, "top-trending");
  const candidates = (query.data ?? []).slice(0, 16).filter((game) => gameId(game) > 0);
  const histories = useQueries({ queries: candidates.map((game) => archiveOptions("gameDaily", gameId(game))) });
  const ranked = candidates.flatMap((game, i) => {
    const daily = measurements(histories[i].data, (row) => row.at, (row) => row.average, "RoWatcher daily average");
    const latest = daily.at(-1)?.at;
    if (latest == null || Date.now() - latest > 3 * DAY) return [];
    const growth = growthBetween(daily, 7);
    return growth != null && growth > 0 ? [{ game, growth, points: daily.filter((row) => row.at > latest - 7 * DAY) }] : [];
  }).sort((a, b) => b.growth - a.growth);
  const cards = go ? ranked.slice(0, 5) : ranked;
  const pending = histories.some((history) => history.isPending);
  return <AnalyticsCard title="Rising This Week" description="Seven-day average versus the previous seven days among Roblox’s leading trending games."
    action={go && <More onClick={() => go("Rising")} />}>
    <Feedback query={{ isPending: query.isPending || pending, isError: query.isError || histories.some((history) => history.isError),
      refetch: () => { void query.refetch(); for (const history of histories) if (history.isError) void history.refetch(); } }}
      empty={!cards.length} label="weekly growth records" />
    <div className="analytics-rise-grid">{cards.map(({ game, growth, points }) => <button key={gameId(game)} className="analytics-rise" onClick={() => select(gameId(game))}>
      <span className="analytics-rise-title"><Image game={game} /><span className="analytics-rank-text"><strong>{game.name}</strong><small>{gameGenre(game)}</small></span></span>
      <span className="analytics-growth"><span>{printed(players(game))} playing</span><strong className="analytics-positive">{percent(growth)}</strong></span>
      <HistoryChart size="compact" points={points} from={points[0].at} to={points.at(-1)!.at} gap={DAY * 1.5} format={(value) => count(value)} />
    </button>)}</div>
    <Source url={`${WATCH}/developers`}>RoWatcher (CC BY 4.0)</Source>
  </AnalyticsCard>;
}

function Charts({ select, go, picked, topOnly = false }: { select: Select; go?: Go; picked?: string; topOnly?: boolean }) {
  const [chart, setChart] = useState<ChartName>(() => charts.find(([key]) => key === picked)?.[0] ?? "top-playing-now");
  const query = useArchive("officialChart", undefined, topOnly ? "top-earning" : chart);
  const estimate = useArchive("games");
  const [showEstimate, setShowEstimate] = useState(false);
  const data = (query.data ?? []);
  const title = topOnly ? "Top Earners" : "Roblox Charts";
  const estimates = (estimate.data ?? []).filter((game) => number(game.estimatedMonthlyRevenueUsd) != null)
    .sort((a, b) => b.estimatedMonthlyRevenueUsd! - a.estimatedMonthlyRevenueUsd!);
  const mode = topOnly && showEstimate;
  return <AnalyticsCard title={title} description={mode ? "Modeled monthly figures from RoWatcher for the 50 most-played tracked games."
    : "Official Roblox chart order for computer users, all countries. Roblox does not disclose earnings amounts here."}
    action={go && <More onClick={() => go("Charts", chart)} />}>
    {topOnly ? <div className="analytics-segment" role="group" aria-label="Earnings data source">
      <button aria-pressed={!showEstimate} onClick={() => setShowEstimate(false)}>Official Top Earning</button>
      <button aria-pressed={showEstimate} onClick={() => setShowEstimate(true)}>Revenue estimates</button>
    </div> : <label className="analytics-toolbar text-sm">Official chart <select aria-label="Official Roblox chart" className="field" value={chart}
      onChange={(event) => setChart(event.target.value as ChartName)}>{charts.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>}
    <Feedback query={mode ? estimate : query} empty={!(mode ? estimates : data).length} label={mode ? "revenue estimates" : "official chart entries"} />
    <RankedGames games={mode ? estimates : go ? data.slice(0, 5) : data} select={select} detail={mode ? (game) => <>
      <strong><Revenue estimate={monthlyEstimate(game.estimatedMonthlyRevenueUsd, game.estimatedDailyRevenueRobux)} /></strong>
      <small>Est. per month{at(game.lastScraped) != null ? ` · ${fmtDate(at(game.lastScraped)!, { dateStyle: "medium" })}` : ""}</small></> : undefined} />
    {mode && <RevenueAssumptions />}
    <Source url={mode ? `${WATCH}/methodology` : ROBLOX_CHARTS}>{mode ? "RoWatcher methodology" : "Official Roblox Charts"}</Source>
  </AnalyticsCard>;
}

function GameBrowser({ select, genre = "", overview = false, go }: { select: Select; genre?: string; overview?: boolean; go?: Go }) {
  const [page, setPage] = useState(1);
  const query = useArchive("games", undefined, genre, page);
  const list = query.data ?? [];
  return <AnalyticsCard title={genre ? `${genre} Games` : "Most Played Games"} description="Live snapshots, ranked by RoWatcher."
    action={overview && go ? <More onClick={() => go("Games")} /> : undefined}>
    <Feedback query={query} empty={!list.length} label="games" />
    <RankedGames games={overview ? list.slice(0, 5) : list} select={select} />
    {!overview && <div className="analytics-toolbar">
      <button className="btn btn-sm" disabled={page === 1 || query.isFetching} onClick={() => setPage(page - 1)}>Previous</button>
      <span>Page {page}</span>
      <button className="btn btn-sm" disabled={page >= 200 || list.length < 50 || query.isFetching} onClick={() => setPage(page + 1)}>Next</button>
    </div>}
    <Source url={`${WATCH}/developers`}>RoWatcher</Source>
  </AnalyticsCard>;
}

function Genres({ select, picked, go }: { select: Select; picked?: string; go?: Go }) {
  const query = useArchive("platformHistory");
  const [genre, setGenre] = useState(picked ?? "");
  const active = (query.data?.genreShare ?? []).filter((row) => number(row.value) != null && row.genre)
    .sort((a, b) => b.value - a.value);
  const max = active[0]?.value || 1;
  return <>
    <AnalyticsCard title="Trending Genres" description="Current players in RobloxGameStats’s tracked games, grouped by genre."
      action={go && <More onClick={() => go("Genres")} />}>
      <Feedback query={query} label="genre readings" empty={!active.length} />
      <div className="analytics-genre-list">{(go ? active.slice(0, 6) : active).map(({ genre: name, value }) =>
        <button key={name} className="analytics-genre" aria-pressed={!go && genre === name} onClick={() => go ? go("Genres", name) : setGenre(name)}>
          <span><strong>{name}</strong><small>{printed(value)}</small></span>
          <span className="analytics-genre-track"><span style={{ width: `${100 * value / max}%` }} /></span>
        </button>)}</div>
      <Source url={`${STATS}/docs/api`}>RobloxGameStats</Source>
    </AnalyticsCard>
    {!go && genre && <GameBrowser key={genre} genre={genre === "Roleplay" ? "Roleplay & Avatar Sim" : genre} select={select} />}
  </>;
}

const STUDIO_PAGE = 8;
type CreatorType = "Group" | "User";
type StudioTotal = { estimate: EstimateValue; models: number };

function totalEstimates(rows: EstimateValue[]): StudioTotal {
  const usd = rows.flatMap((row) => row.dollars == null ? [] : [row.dollars]);
  const robux = rows.flatMap((row) => row.robux == null ? [] : [row.robux]);
  return {
    estimate: { dollars: usd.length ? usd.reduce((a, b) => a + b, 0) : null, robux: robux.length ? robux.reduce((a, b) => a + b, 0) : null },
    models: rows.filter((row) => row.dollars != null || row.robux != null).length,
  };
}

function studioMetrics(studio: Studio, portfolio?: Portfolio | null) {
  const gameCount = portfolio?.publishedGames;
  return {
    playing: portfolio?.activePlayers ?? number(studio.totalPlaying),
    visits: portfolio?.visits ?? number(studio.totalVisits),
    games: gameCount == null ? "Unavailable" : fmtNum(gameCount) + (portfolio?.complete ? "" : "+"),
    scope: portfolio?.complete && portfolio.activePlayers != null && portfolio.visits != null ? "Roblox public portfolio"
      : portfolio && !portfolio.complete ? "Portfolio lookup capped at 200 games" : "Activity from RoWatcher's tracked games",
  };
}

function StudioIcon({ studio, size }: { studio: Studio; size?: "large" }) {
  const [failed, setFailed] = useState<string>();
  const icon = thumb(studio);
  const css = `analytics-game-icon ${size === "large" ? "analytics-studio-avatar" : ""}`;
  return icon && icon !== failed ? <img src={icon} alt="" className={css} loading="lazy" onError={() => setFailed(icon)} />
    : <span className={css + " analytics-icon-placeholder"} aria-hidden><Icon name="accounts" size={size === "large" ? 26 : 17} /></span>;
}

function StudioDetails({ studio, kind, selected, back, estimates }: {
  studio: Studio; kind: CreatorType; selected: Select; back: () => void; estimates: MarketGame[];
}) {
  const id = number(studio.creatorId) ?? 0;
  const profile = useArchive("studioPortfolio", id, kind);
  const [sort, setSort] = useState<"players" | "visits" | "new">("players");
  const [filter, setFilter] = useState("");
  const portfolio = profile.data;
  const metrics = studioMetrics(studio, portfolio);
  const games = [...portfolio?.games ?? []].sort((a, b) => {
    if (sort === "visits") return (b.visits ?? -1) - (a.visits ?? -1);
    if (sort === "new") return (at(b.created) ?? 0) - (at(a.created) ?? 0);
    return (b.playing ?? -1) - (a.playing ?? -1);
  });
  const gamesByPopularity = [...portfolio?.games ?? []].sort((a, b) => (b.playing ?? -1) - (a.playing ?? -1));
  const pricedIds = new Map(estimates.map((row) => [gameId(row), row]));
  const unmodeled = gamesByPopularity.filter((game) => !pricedIds.has(game.universeId)).slice(0, 10);
  const models = useQueries({ queries: unmodeled.map((game) => archiveOptions("gameEstimate", game.universeId)) });
  const monthly = totalEstimates(gamesByPopularity.flatMap((game) => {
    const row = pricedIds.get(game.universeId);
    return row ? [monthlyEstimate(row.estimatedMonthlyRevenueUsd, row.estimatedDailyRevenueRobux)] : [];
  }).concat(models.flatMap(({ data }) => data ? [monthlyEstimate(data.estimate, data.robuxPerDay)] : [])));
  const displayed = games.filter((game) => game.name.toLowerCase().includes(filter.toLowerCase()));
  return <div className="analytics-market">
    <AnalyticsCard title={studio.creatorName} description={kind === "Group" ? "Roblox community" : "Roblox developer"} action={<More onClick={back}>All creators</More>}>
      <div className="analytics-toolbar">
        <StudioIcon studio={studio} size="large" />
        <Source url={kind === "Group" ? `https://www.roblox.com/communities/${id}` : `https://www.roblox.com/users/${id}/profile`}>
          {kind === "Group" ? "Open Roblox community" : "Open Roblox profile"}
        </Source>
      </div>
      <dl className="analytics-stat-grid">
        <div><dt>Active players</dt><dd>{printed(metrics.playing)}</dd></div>
        <div><dt>Total visits</dt><dd>{printed(metrics.visits)}</dd></div>
        <div><dt>Published games</dt><dd>{metrics.games}</dd></div>
        <div><dt>Estimated monthly revenue</dt><dd><Revenue estimate={monthly.estimate} /></dd></div>
      </dl>
      <p className="analytics-feedback">{metrics.scope}{portfolio ? ` · ${fmtDate(portfolio.observedAt)}` : ""}
        {monthly.models ? ` · Estimate covers ${fmtNum(monthly.models)} of ${fmtNum(games.length)} listed games` : ""}
      </p>
      <RevenueAssumptions />
      <Source url={`${WATCH}/methodology`}>RoWatcher estimate methodology</Source>
    </AnalyticsCard>
    <AnalyticsCard title="Published Experiences" description="Public Roblox experiences for this creator.">
      <div className="analytics-toolbar">
        <input type="search" className="field" aria-label="Filter studio games" placeholder="Filter games" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select className="field" aria-label="Sort studio games" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="players">Most players</option><option value="visits">Most visits</option><option value="new">Newest</option>
        </select>
      </div>
      <Feedback query={profile} empty={!displayed.length} label={filter ? "matching games" : "published experiences"} />
      <RankedGames games={displayed.map((game) => ({
        universeId: game.universeId, name: game.name, playing: game.playing ?? undefined,
        genre: game.genre ?? undefined, visits: game.visits ?? undefined,
        iconUrl: pricedIds.get(game.universeId)?.iconUrl ?? game.icon ?? undefined,
      }))} select={selected} detail={(game) => <><strong>{printed(players(game))} playing</strong><small>{printed(number(game.visits))} visits</small></>} />
    </AnalyticsCard>
  </div>;
}

function Studios({ select }: { select: Select }) {
  const [kind, setKind] = useState<CreatorType>("Group");
  const [chosen, setChosen] = useState<Studio>();
  const [page, setPage] = useState(0);
  const query = useArchive("studios", undefined, kind);
  const market = useArchive("studioEstimates");
  const list = (query.data ?? []).filter((row) => !!number(row.creatorId));
  const rows = list.slice(page * STUDIO_PAGE, (page + 1) * STUDIO_PAGE);
  const portfolios = useQueries({ queries: chosen ? [] : rows.map((row) => archiveOptions("studioPortfolio", number(row.creatorId)!, kind)) });
  if (chosen) {
    return <StudioDetails key={chosen.creatorId} studio={chosen} kind={kind} selected={select} back={() => setChosen(undefined)} estimates={market.data ?? []} />;
  }
  return <AnalyticsCard title="Studios and Creators" description="Ranked by active players across RoWatcher's tracked experiences."
    action={<select className="field" aria-label="Creator type" value={kind} onChange={(event) => { setKind(event.target.value as CreatorType); setPage(0); }}>
      <option value="Group">Roblox communities</option><option value="User">Individual developers</option>
    </select>}>
    <Feedback query={query} empty={!list.length} label="creators" />
    <ol className="analytics-ranked">{rows.map((studio, i) => {
      const profile = portfolios[i];
      const metrics = studioMetrics(studio, profile.data);
      const matching = (market.data ?? []).filter((game) => number(game.creatorId) === number(studio.creatorId) && game.creatorType === kind);
      const monthly = totalEstimates(matching.map((game) => monthlyEstimate(game.estimatedMonthlyRevenueUsd, game.estimatedDailyRevenueRobux)));
      return <li key={studio.creatorId}>
        <button className="analytics-studio-row" onClick={() => setChosen(studio)} aria-label={`Open studio analytics for ${studio.creatorName}`}>
          <span className="analytics-rank">{fmtNum(page * STUDIO_PAGE + i + 1)}</span>
          <StudioIcon studio={studio} />
          <span className="analytics-rank-text"><strong>{studio.creatorName}</strong><small>{metrics.scope}</small></span>
          <span className="analytics-studio-stat"><small>Active players</small><strong>{printed(metrics.playing)}</strong></span>
          <span className="analytics-studio-stat"><small>Total visits</small><strong>{printed(metrics.visits)}</strong></span>
          <span className="analytics-studio-stat"><small>Published games</small><strong>{profile.isPending ? "Loading…" : metrics.games}</strong></span>
          <span className="analytics-studio-stat"><small>Est. monthly{monthly.models ? ` · ${fmtNum(monthly.models)} ${monthly.models === 1 ? "game" : "games"}` : ""}</small><strong><Revenue estimate={monthly.estimate} /></strong></span>
        </button>
      </li>;
    })}</ol>
    {list.length > STUDIO_PAGE && <div className="analytics-toolbar">
      <button className="btn btn-sm" disabled={!page} onClick={() => setPage(page - 1)}>Previous studios</button>
      <span>Page {fmtNum(page + 1)} of {fmtNum(Math.ceil(list.length / STUDIO_PAGE))}</span>
      <button className="btn btn-sm" disabled={(page + 1) * STUDIO_PAGE >= list.length} onClick={() => setPage(page + 1)}>Next studios</button>
    </div>}
    <p className="analytics-feedback">Directory estimates cover matched games in RoWatcher's top 100 by players. Open a studio for its public portfolio.</p>
    <Source url={`${WATCH}/methodology`}>RoWatcher methodology</Source>
  </AnalyticsCard>;
}

function Trends({ select }: { select: Select }) {
  const tags = useArchive("trends");
  const market = useArchive("games");
  const [chosen, setChosen] = useState("");
  const [filter, setFilter] = useState("");
  const ranked = useMemo(() => (tags.data ?? []).flatMap((tag) => {
    const keywords = new Set((tag.keywords ?? []).filter((word) => word.trim().length >= 2).map((word) => word.toLocaleLowerCase()));
    const games = (market.data ?? []).filter((game) => {
      const title = (game.name ?? "").toLocaleLowerCase();
      const tokens: string[] = title.match(/[\p{L}\p{N}+]+/gu) ?? [];
      return [...keywords].some((word) => word.includes(" ") ? title.includes(word) : tokens.includes(word));
    });
    return games.length ? [{ tag, games, live: games.reduce((sum, game) => sum + (players(game) ?? 0), 0) }] : [];
  }).sort((a, b) => b.live - a.live), [tags.data, market.data]);
  return <AnalyticsCard title="Trends" description="Themes and mechanics found in the names of RoWatcher’s 50 most-played tracked experiences.">
    <input type="search" className="field" placeholder="Filter trends" aria-label="Filter trends" value={filter} onChange={(event) => setFilter(event.target.value)} />
    <Feedback query={{ isPending: tags.isPending || market.isPending, isError: tags.isError || market.isError,
      refetch: () => { void tags.refetch(); void market.refetch(); } }} empty={!ranked.length} label="trend matches" />
    <div className="flex flex-wrap gap-2">{ranked.filter(({ tag }) => tag.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(({ tag, live }) =>
      <button key={tag.id} className={chosen === tag.id ? "btn btn-primary" : "btn"} aria-pressed={chosen === tag.id}
        onClick={() => setChosen(tag.id)}>{tag.name}<span>{printed(live)}</span></button>)}</div>
    <RankedGames games={ranked.find((item) => item.tag.id === chosen)?.games ?? []} select={select} />
    <Source url={`${WATCH}/developers`}>RoWatcher</Source>
  </AnalyticsCard>;
}

export function MarketOverview({ select, go }: { select: Select; go: Go }) {
  return <div className="analytics-market">
    <div className="analytics-top"><Platform expand={() => go("Charts", "platform")} /><Pulse select={select} go={go} /></div>
    <Rising select={select} go={go} />
    <div className="analytics-columns"><Records select={select} go={go} /><NewGames select={select} go={go} /></div>
    <div className="analytics-columns"><GameBrowser select={select} go={go} overview /><Charts select={select} go={go} /></div>
    <Genres select={select} go={go} />
  </div>;
}

export function MarketSection({ section, select, picked }: { section: Section; select: Select; picked?: string }) {
  switch (section) {
    case "Studios": return <Studios select={select} />;
    case "Top Earners": return <Charts select={select} topOnly />;
    case "Games": return <GameBrowser select={select} />;
    case "Rising": return <Rising select={select} />;
    case "Trends": return <Trends select={select} />;
    case "Genres": return <Genres select={select} picked={picked} />;
    case "Charts": return <ChartSection select={select} picked={picked} />;
    case "New Games": return <NewGames select={select} />;
    case "New Highs": return <Records select={select} />;
    case "Calendar": return <Calendar select={select} />;
    default: return null;
  }
}

function ChartSection({ select, picked }: { select: Select; picked?: string }) {
  const [platform, setPlatform] = useState(picked === "platform");
  return <div className="space-y-3">
    <div className="analytics-segment" role="group" aria-label="Chart source">
      <button aria-pressed={!platform} onClick={() => setPlatform(false)}>Official game charts</button>
      <button aria-pressed={platform} onClick={() => setPlatform(true)}>Platform player history</button>
    </div>
    {platform ? <Platform full /> : <Charts select={select} picked={picked} />}
  </div>;
}
