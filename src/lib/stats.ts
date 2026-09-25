import { and, eq, or, sql } from 'drizzle-orm';
import { games } from '../db/schema';
import type { Db } from '../types';

export async function getStats(db: Db, uid: string) {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      draws: sql<number>`coalesce(sum(case when ${games.result} = 'draw' then 1 else 0 end), 0)`,
      wins: sql<number>`coalesce(sum(case when (${games.result} = 'p1' and ${games.p1Id} = ${uid})
                                          or (${games.result} = 'p2' and ${games.p2Id} = ${uid}) then 1 else 0 end), 0)`,
    })
    .from(games)
    .where(and(eq(games.status, 'finished'), or(eq(games.p1Id, uid), eq(games.p2Id, uid))));

  const wins = Number(row.wins);
  const draws = Number(row.draws);
  return { wins, draws, losses: Number(row.total) - wins - draws };
}
