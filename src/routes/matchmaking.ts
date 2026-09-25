import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, inArray, lt, or } from 'drizzle-orm';
import { games, matchQueue } from '../db/schema';
import { requireAuth } from '../lib/auth';
import { cardSchema } from '../lib/bingo';
import type { AppEnv, Db } from '../types';

const mm = new Hono<AppEnv>();
mm.use('*', requireAuth);

/**
 * Race-free pairing without transactions.
 * Rule: a player only ever claims someone who joined BEFORE them, so of any two
 * players only one can be the "claimer". Every step is a single atomic
 * DELETE ... RETURNING, so nobody can be claimed twice.
 */
async function tryMatch(db: Db, uid: string) {
  // 1. Take myself out of the queue. If that returns nothing, I was already claimed.
  const [me] = await db.delete(matchQueue).where(eq(matchQueue.userId, uid)).returning();
  if (!me) return;

  // 2. Atomically claim the oldest player who joined before me.
  const older = db
    .select({ id: matchQueue.userId })
    .from(matchQueue)
    .where(
      or(
        lt(matchQueue.createdAt, me.createdAt),
        and(eq(matchQueue.createdAt, me.createdAt), lt(matchQueue.userId, me.userId)),
      ),
    )
    .orderBy(asc(matchQueue.createdAt), asc(matchQueue.userId))
    .limit(1);
  const [opp] = await db.delete(matchQueue).where(inArray(matchQueue.userId, older)).returning();

  // 3. Nobody available: go back to waiting.
  if (!opp) {
    await db.insert(matchQueue).values(me).onConflictDoNothing();
    return;
  }

  // 4. Matched. Random seat decides who moves first (P1 always starts).
  const meFirst = Math.random() < 0.5;
  const [p1, p2] = meFirst ? [me, opp] : [opp, me];
  await db.insert(games).values({
    id: crypto.randomUUID(),
    p1Id: p1.userId,
    p2Id: p2.userId,
    p1Card: p1.card,
    p2Card: p2.card,
  });
}

async function getStatus(db: Db, uid: string) {
  const [active] = await db
    .select({ id: games.id })
    .from(games)
    .where(and(eq(games.status, 'active'), or(eq(games.p1Id, uid), eq(games.p2Id, uid))))
    .limit(1);
  if (active) return { status: 'matched' as const, gameId: active.id };

  const [queued] = await db.select().from(matchQueue).where(eq(matchQueue.userId, uid));
  return queued ? { status: 'waiting' as const } : { status: 'idle' as const };
}

mm.post('/join', zValidator('json', z.object({ card: cardSchema })), async (c) => {
  const db = c.get('db');
  const uid = c.get('userId');

  const existing = await getStatus(db, uid);
  if (existing.status === 'matched') return c.json(existing);

  const now = Date.now();
  const { card } = c.req.valid('json');
  await db
    .insert(matchQueue)
    .values({ userId: uid, card, createdAt: now })
    .onConflictDoUpdate({ target: matchQueue.userId, set: { card, createdAt: now } });

  await tryMatch(db, uid);
  return c.json(await getStatus(db, uid));
});

/** Poll this every ~2s while showing "Finding player...". */
mm.get('/status', async (c) => {
  const db = c.get('db');
  const uid = c.get('userId');
  const current = await getStatus(db, uid);
  if (current.status === 'waiting') {
    await tryMatch(db, uid); // safety net for rare timing races
    return c.json(await getStatus(db, uid));
  }
  return c.json(current);
});

/** Cancel search (dialog dismissed). */
mm.delete('/', async (c) => {
  await c.get('db').delete(matchQueue).where(eq(matchQueue.userId, c.get('userId')));
  return c.json({ ok: true });
});

export default mm;
