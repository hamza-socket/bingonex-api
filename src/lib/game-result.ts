import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { users } from "../db/schema";
import { calculateDrawElo, calculateMatchElo } from "./elo-cal";

export type Seat = { userId: string; rating: number };

export type GameResult = {
  roomId: string;
  aId: string;
  bId: string;
  winner: "a" | "b" | null;
  deltaA: number;
  deltaB: number;
};

export type D1Db = ReturnType<typeof drizzle>;

export async function readRatings(d1: D1Database, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  try {
    const rows = await drizzle(d1)
      .select({ id: users.id, rating: users.rating })
      .from(users)
      .where(inArray(users.id, ids));
    return new Map(rows.map((row) => [row.id, row.rating]));
  } catch {
    return new Map();
  }
}

export async function computeResult(
  d1: D1Database,
  roomId: string,
  a: Seat,
  b: Seat,
  winner: "a" | "b" | null,
): Promise<GameResult> {
  const fresh = await readRatings(d1, [a.userId, b.userId]);
  const ratingA = fresh.get(a.userId) ?? a.rating;
  const ratingB = fresh.get(b.userId) ?? b.rating;

  if (winner === null) {
    const { playerA, playerB } = calculateDrawElo(ratingA, ratingB);
    return {
      roomId,
      aId: a.userId,
      bId: b.userId,
      winner,
      deltaA: playerA.change,
      deltaB: playerB.change,
    };
  }

  const [winnerRating, loserRating] = winner === "a" ? [ratingA, ratingB] : [ratingB, ratingA];
  const { winner: won, loser: lost } = calculateMatchElo(winnerRating, loserRating);
  return {
    roomId,
    aId: a.userId,
    bId: b.userId,
    winner,
    deltaA: winner === "a" ? won.change : lost.change,
    deltaB: winner === "b" ? won.change : lost.change,
  };
}

export function ratingUpdates(db: D1Db, result: GameResult) {
  const bump = (id: string, delta: number) =>
    db
      .update(users)
      .set({ rating: sql`${users.rating} + ${delta}` })
      .where(eq(users.id, id));
  return [bump(result.aId, result.deltaA), bump(result.bId, result.deltaB)] as const;
}