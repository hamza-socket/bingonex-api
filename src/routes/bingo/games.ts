import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type Game, games, users } from "../../db/schema";
import { requireAuth } from "../../lib/auth";
<<<<<<< HEAD
import { countLines, numberSchema, WIN_LINES } from "../../lib/bingo";
import type { AppEnv, Db } from "../../types/types";
=======
import type { AppEnv, Bindings, Db } from "../../types";
>>>>>>> c81ef6e (did stuff)

const gamesRoute = new Hono<AppEnv>();
gamesRoute.use("*", requireAuth);

const idParam = zValidator("param", z.object({ id: z.string().uuid() }));

const roomStub = (env: Bindings, id: string) => env.BINGO_ROOM.get(env.BINGO_ROOM.idFromName(id));
const matchmakingStub = (env: Bindings) =>
  env.MATCHMAKING_ROOM.get(env.MATCHMAKING_ROOM.idFromName("global"));

async function toView(db: Db, g: Game, uid: string) {
  const isP1 = g.p1Id === uid;
  const oppId = isP1 ? g.p2Id : g.p1Id;
  const [opponent] = await db
    .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, oppId));

  const you = isP1 ? "p1" : "p2";
  return {
    id: g.id,
    side: you,
    status: g.status,
    outcome: g.result === "draw" ? "draw" : g.result === you ? "win" : "loss",
    endReason: null,
    yourTurn: false,
    card: isP1 ? g.p1Card : g.p2Card,
    called: g.called,
    lastCalled: g.called.at(-1) ?? null,
    yourLines: isP1 ? g.p1Lines : g.p2Lines,
    opponentLines: isP1 ? g.p2Lines : g.p1Lines,
    opponent: opponent ? { ...opponent, connected: false } : null,
    opponentCard: isP1 ? g.p2Card : g.p1Card,
    moveCount: g.moveCount,
    ratingChange: null,
  };
}


gamesRoute.get("/active", async (c) => {
  const response = await matchmakingStub(c.env).fetch(
    `http://do/internal/queue/status?gameId=bingo&userId=${encodeURIComponent(c.get("userId"))}`,
  );
  if (!response.ok) return c.json({ error: "unavailable" }, 502);
  const data = await response.json<{ status: string; match?: { roomId: string } }>();
  return c.json({ gameId: data.status === "matched" ? (data.match?.roomId ?? null) : null });
});



gamesRoute.get("/:id", idParam, async (c) => {
  const db = c.get("db");
  const uid = c.get("userId");
  const { id } = c.req.valid("param");

  const [finished] = await db.select().from(games).where(eq(games.id, id));
  if (finished) {
    if (finished.p1Id !== uid && finished.p2Id !== uid) {
      return c.json({ error: "forbidden" }, 403);
    }
    return c.json(await toView(db, finished, uid));
  }

  const response = await roomStub(c.env, id).fetch("http://do/state", {
    headers: { "x-user-id": uid },
  });
  if (response.status === 403) return c.json({ error: "forbidden" }, 403);
  if (!response.ok) return c.json({ error: "not_found" }, 404);
  return c.json(await response.json<Record<string, unknown>>());
});



gamesRoute.post("/:id/connect", idParam, async (c) => {
  const { id } = c.req.valid("param");
  const response = await roomStub(c.env, id).fetch("http://do/internal/issue-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: c.get("userId") }),
  });
  if (response.status === 403) return c.json({ error: "forbidden" }, 403);
  if (!response.ok) return c.json({ error: "not_found" }, 404);
  return c.json(await response.json<Record<string, unknown>>());
});




gamesRoute.get("/:id/ws", idParam, async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "upgrade_required" }, 426);
  }
  const { id } = c.req.valid("param");
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-user-id", c.get("userId"));
  return roomStub(c.env, id).fetch(new Request(c.req.raw, { headers }));
});

export default gamesRoute;