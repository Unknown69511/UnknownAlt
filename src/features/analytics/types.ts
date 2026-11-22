export type Creator = { id: number | null; name: string | null; kind: string | null };
export type PublicGame = {
  universeId: number;
  rootPlaceId: number;
  name: string;
  creator: Creator;
  playing: number | null;
  visits: number | null;
  favorites: number | null;
  updated: string | null;
  icon: string | null;
  thumbnail: string | null;
  likes: number | null;
  dislikes: number | null;
};
export type PublicSnapshot = { observedAt: number; games: PublicGame[] };
export type CreatorMetric = "active" | "newPlayers" | "session" | "dayOne" | "daySeven" | "revenue" | "traffic" | "payers" | "engagement";
export type MetricSeries = { breakdowns: { dimension: string; value: string }[]; dataPoints: { time: string; value: number | null }[] };
