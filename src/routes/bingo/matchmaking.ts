import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { users } from "../../db/schema";
import { requireAuth } from "../../lib/auth";
import { cardSchema } from "../../lib/bingo";
<<<<<<< HEAD
import type { AppEnv, Bindings, Db } from "../../types/types";
=======
import type { AppEnv, Bindings } from "../../types";
>>>>>>> c81ef6e (did stuff)

const GAME_ID = "bingo";

type Opponent = { userId: string; username: string; elo: number };

type Assignment = {
  matchId: string;
  gameId: string;
  roomId: string;
  token: string;
  side: "p1" | "p2";
  opponent: Opponent;
};

type QueueStatus = {
  status: "waiting" | "idle" | "matched";
  match?: Assignment;
};

const mm = new Hono<AppEnv>();
mm.use("*", requireAuth);

const matchmakingStub = (env: Bindings) =>
  env.MATCHMAKING_ROOM.get(env.MATCHMAKING_ROOM.idFromName("global"));

function toClient(status: QueueStatus) {
  if (status.status === "matched" && status.match) {
    const { roomId, token, side, opponent } = status.match;
    return { status: "matched" as const, gameId: roomId, token, side, opponent };
  }
  return { status: status.status };
}

async function readStatus(env: Bindings, userId: string): Promise<QueueStatus> {
  const response = await matchmakingStub(env).fetch(
    `http://do/internal/queue/status?gameId=${GAME_ID}&userId=${encodeURIComponent(userId)}`,
  );
  if (!response.ok) throw new Error("Failed to read matchmaking status");
  return response.json<QueueStatus>();
}

mm.post("/join", zValidator("json", z.object({ card: cardSchema.optional() })), async (c) => {
  const uid = c.get("userId");

  const current = await readStatus(c.env, uid);
  if (current.status === "matched") return c.json(toClient(current));

  const [player] = await c
    .get("db")
    .select({
      name: users.name,
      rating: users.rating,
      avatarUrl: users.avatarUrl,
      bannedAt: users.bannedAt,
    })
    .from(users)
    .where(eq(users.id, uid));
  if (!player) return c.json({ error: "user_not_found" }, 404);
  if (player.bannedAt) return c.json({ error: "banned" }, 403);

  const { card } = c.req.valid("json");
  const response = await matchmakingStub(c.env).fetch("http://do/internal/queue/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      gameId: GAME_ID,
      userId: uid,
      username: player.name,
      elo: player.rating,
      metadata: { card, avatarUrl: player.avatarUrl },
    }),
  });
  if (!response.ok) return c.json({ error: "join_failed" }, 502);

  return c.json(toClient(await response.json<QueueStatus>()));
});

mm.get("/status", async (c) => {
  return c.json(toClient(await readStatus(c.env, c.get("userId"))));
});

mm.delete("/", async (c) => {
  const response = await matchmakingStub(c.env).fetch("http://do/internal/queue/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId: GAME_ID, userId: c.get("userId") }),
  });
  if (!response.ok) return c.json({ error: "cancel_failed" }, 502);
  return c.json({ ok: true });
});

export default mm;