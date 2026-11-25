export type PublicGame = {
  universeId: number;
  rootPlaceId: number;
  name: string;
  creator: { name: string | null };
  playing: number | null;
  updated: string | null;
  created?: string | null;
  genre?: string | null;
  subgenre?: string | null;
  description?: string | null;
  icon: string | null;
  thumbnail: string | null;
  likes: number | null;
  dislikes: number | null;
};

export type PublicSnapshot = { observedAt: number; games: PublicGame[] };
export type Discovery = { snapshot: PublicSnapshot; trending: number[]; popular: number[]; rising: number[] };
export type GameUpdate = { universeId: number; name: string; updated: string };
