import { zValidator } from "@hono/zod-validator";
import { and, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { games, users } from "../../db/schema";
import { requireAuth } from "../../lib/auth";
import { cardSchema } from "../../lib/bingo";
import type { AppEnv, Bindings, Db } from "../../types";

const mm = new Hono<AppEnv>();
mm.use("*", requireAuth);

type MatchPlayer = {
  userId: string;
  username: string;
  elo: number;
  metadata?: Record<string, unknown>;
};

type QueueStatus = {
  status: "waiting" | "idle" | "matched";
  match?: {
    matchId: string;
    gameId: string;
    players: [MatchPlayer, MatchPlayer];
  };
};

function getMatchmakingStub(env: Bindings) {
  return env.MATCHMAKING_ROOM.get(env.MATCHMAKING_ROOM.idFromName("global"));
}

async function getStatus(db: Db, env: Bindings, uid: string) {
  const [active] = await db
    .select({ id: games.id })
    .from(games)
    .where(and(eq(games.status, "active"), or(eq(games.p1Id, uid), eq(games.p2Id, uid))))
    .limit(1);

  const response = await getMatchmakingStub(env).fetch(
    `http://do/internal/queue/status?gameId=bingo&userId=${encodeURIComponent(uid)}`,
  );
  if (!response.ok) throw new Error("Failed to read matchmaking status");
  const queueStatus = (await response.json()) as QueueStatus;
  if (queueStatus.status !== "matched" || !queueStatus.match) {
    if (active) return { status: "matched" as const, gameId: active.id };
    return { status: queueStatus.status };
  }

  const [p1, p2] = queueStatus.match.players;
  const p1Card = cardSchema.safeParse(p1.metadata?.card);
  const p2Card = cardSchema.safeParse(p2.metadata?.card);
  if (!p1Card.success || !p2Card.success) {
    throw new Error("Matchmaking returned invalid bingo cards");
  }

  await db
    .insert(games)
    .values({
      id: queueStatus.match.matchId,
      p1Id: p1.userId,
      p2Id: p2.userId,
      p1Card: p1Card.data,
      p2Card: p2Card.data,
    })
    .onConflictDoNothing();

  const room = env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(queueStatus.match.matchId));
  for (const player of [
    { playerId: p1.userId, card: p1Card.data },
    { playerId: p2.userId, card: p2Card.data },
  ]) {
    const joinResponse = await room.fetch(
      new Request("https://game-room/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(player),
      }),
    );
    if (!joinResponse.ok) throw new Error("Failed to initialize bingo game room");
  }

  for (const player of [p1, p2]) {
    const ackResponse = await getMatchmakingStub(env).fetch("http://do/internal/queue/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gameId: queueStatus.match.gameId,
        userId: player.userId,
        matchId: queueStatus.match.matchId,
      }),
    });
    if (!ackResponse.ok) throw new Error("Failed to acknowledge bingo match");
  }

  return { status: "matched" as const, gameId: queueStatus.match.matchId };
}

async function joinMatchmaking(db: Db, env: Bindings, uid: string, card: number[]) {
  const [player] = await db
    .select({ name: users.name, rating: users.rating })
    .from(users)
    .where(eq(users.id, uid));
  if (!player) throw new Error("Authenticated user was not found");

  const response = await getMatchmakingStub(env).fetch("http://do/internal/queue/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      gameId: "bingo",
      userId: uid,
      username: player.name,
      elo: player.rating,
      metadata: { card },
    }),
  });
  if (!response.ok) throw new Error("Failed to join bingo matchmaking queue");
}

mm.post("/join", zValidator("json", z.object({ card: cardSchema })), async (c) => {
  const db = c.get("db");
  const uid = c.get("userId");
  const existing = await getStatus(db, c.env, uid);
  if (existing.status === "matched") return c.json(existing);

  const { card } = c.req.valid("json");
  await joinMatchmaking(db, c.env, uid, card);
  return c.json(await getStatus(db, c.env, uid));
});

mm.get("/status", async (c) => {
  return c.json(await getStatus(c.get("db"), c.env, c.get("userId")));
});

mm.delete("/", async (c) => {
  const response = await getMatchmakingStub(c.env).fetch("http://do/internal/queue/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId: "bingo", userId: c.get("userId") }),
  });
  if (!response.ok) return c.json({ error: "Failed to cancel matchmaking" }, 500);
  return c.json({ ok: true });
});

export default mm;
