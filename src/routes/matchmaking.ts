import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { games, matchQueue } from "../db/schema";
import { requireAuth } from "../lib/auth";
import { cardSchema } from "../lib/bingo";
import { chooseQueueOpponent } from "../lib/matchmaking";
import type { AppEnv, Bindings, Db } from "../types";

const mm = new Hono<AppEnv>();
mm.use("*", requireAuth);

async function tryMatch(db: Db, env: Bindings, uid: string) {
  const [me] = await db.delete(matchQueue).where(eq(matchQueue.userId, uid)).returning();
  if (!me) return;

  const queued = await db
    .select({
      userId: matchQueue.userId,
      card: matchQueue.card,
      createdAt: matchQueue.createdAt,
    })
    .from(matchQueue)
    .orderBy(asc(matchQueue.createdAt), asc(matchQueue.userId));

  const opp = chooseQueueOpponent(queued, uid);
  if (!opp) {
    await db.insert(matchQueue).values(me).onConflictDoNothing();
    return;
  }

  const [matchedOpp] = await db
    .delete(matchQueue)
    .where(eq(matchQueue.userId, opp.userId))
    .returning();

  if (!matchedOpp) {
    await db.insert(matchQueue).values(me).onConflictDoNothing();
    return;
  }

  const meFirst = Math.random() < 0.5;
  const [p1, p2] = meFirst ? [me, matchedOpp] : [matchedOpp, me];
  const gameId = crypto.randomUUID();

  await db.insert(games).values({
    id: gameId,
    p1Id: p1.userId,
    p2Id: p2.userId,
    p1Card: p1.card,
    p2Card: p2.card,
  });

  const room = env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(gameId));
  await room.fetch(
    new Request("https://example.test/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId: p1.userId, card: p1.card }),
    }),
  );
  await room.fetch(
    new Request("https://example.test/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId: p2.userId, card: p2.card }),
    }),
  );
}

async function getStatus(db: Db, uid: string) {
  const [active] = await db
    .select({ id: games.id })
    .from(games)
    .where(and(eq(games.status, "active"), or(eq(games.p1Id, uid), eq(games.p2Id, uid))))
    .limit(1);
  if (active) return { status: "matched" as const, gameId: active.id };

  const [queued] = await db.select().from(matchQueue).where(eq(matchQueue.userId, uid));
  return queued ? { status: "waiting" as const } : { status: "idle" as const };
}

mm.post("/join", zValidator("json", z.object({ card: cardSchema })), async (c) => {

  const db = c.get("db");
  const uid = c.get("userId");
  const existing = await getStatus(db, uid);
  if (existing.status === "matched") return c.json(existing);

  const now = Date.now();
  const { card } = c.req.valid("json");
  await db
    .insert(matchQueue)
    .values({ userId: uid, card, createdAt: now })
    .onConflictDoUpdate({ target: matchQueue.userId, set: { card, createdAt: now } });

  await tryMatch(db, c.env, uid);
  return c.json(await getStatus(db, uid));
});

mm.get("/status", async (c) => {
  const db = c.get("db");
  const uid = c.get("userId");
  const current = await getStatus(db, uid);
  if (current.status === "waiting") {
    await tryMatch(db, c.env, uid);
    return c.json(await getStatus(db, uid));
  }
  return c.json(current);
});

mm.delete("/", async (c) => {
  await c
    .get("db")
    .delete(matchQueue)
    .where(eq(matchQueue.userId, c.get("userId")));
  return c.json({ ok: true });
});

export default mm;
