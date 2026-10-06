import { zValidator } from "@hono/zod-validator";
import { and, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type Game, games, users } from "../../db/schema";
import { requireAuth } from "../../lib/auth";
import { countLines, numberSchema, WIN_LINES } from "../../lib/bingo";
import type { AppEnv, Db } from "../../types/types";

const gamesRoute = new Hono<AppEnv>();
gamesRoute.use("*", requireAuth);

async function toView(db: Db, g: Game, uid: string) {
  const isP1 = g.p1Id === uid;
  const oppId = isP1 ? g.p2Id : g.p1Id;
  const [opponent] = await db
    .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, oppId));

  const you = isP1 ? "p1" : "p2";
  const finished = g.status === "finished";
  return {
    id: g.id,
    status: g.status,
    outcome: !finished ? null : g.result === "draw" ? "draw" : g.result === you ? "win" : "loss",
    yourTurn: g.status === "active" && g.turn === you,
    card: isP1 ? g.p1Card : g.p2Card,
    called: g.called,
    lastCalled: g.called.at(-1) ?? null,
    yourLines: isP1 ? g.p1Lines : g.p2Lines,
    opponentLines: isP1 ? g.p2Lines : g.p1Lines,
    opponent,
    opponentCard: finished ? (isP1 ? g.p2Card : g.p1Card) : null,
    moveCount: g.moveCount,
  };
}

async function loadGame(db: Db, id: string, uid: string) {
  const [g] = await db.select().from(games).where(eq(games.id, id));
  if (!g) return { error: "not_found" as const, status: 404 as const };
  if (g.p1Id !== uid && g.p2Id !== uid)
    return { error: "forbidden" as const, status: 403 as const };
  return { game: g };
}

gamesRoute.get("/active", async (c) => {
  const uid = c.get("userId");
  const [g] = await c
    .get("db")
    .select({ id: games.id })
    .from(games)
    .where(and(eq(games.status, "active"), or(eq(games.p1Id, uid), eq(games.p2Id, uid))))
    .limit(1);
  return c.json({ gameId: g?.id ?? null });
});

gamesRoute.get("/:id/room", async (c) => {
  const res = await loadGame(c.get("db"), c.req.param("id"), c.get("userId"));
  if ("error" in res) return c.json({ error: res.error }, res.status);

  const room = c.env.GAME_ROOMS.get(c.env.GAME_ROOMS.idFromName(c.req.param("id")));
  return room.fetch(new Request(`${new URL(c.req.url).origin}/state`));
});

gamesRoute.get("/:id", async (c) => {
  const db = c.get("db");
  const res = await loadGame(db, c.req.param("id"), c.get("userId"));
  if ("error" in res) return c.json({ error: res.error }, res.status);
  return c.json(await toView(db, res.game, c.get("userId")));
});

gamesRoute.post("/:id/move", zValidator("json", z.object({ number: numberSchema })), async (c) => {
  const db = c.get("db");
  const uid = c.get("userId");
  const { number } = c.req.valid("json");

  const res = await loadGame(db, c.req.param("id"), uid);
  if ("error" in res) return c.json({ error: res.error }, res.status);
  const g = res.game;

  const you = g.p1Id === uid ? "p1" : "p2";
  if (g.status !== "active") return c.json({ error: "game_over" }, 409);
  if (g.turn !== you) return c.json({ error: "not_your_turn" }, 409);
  if (g.called.includes(number)) return c.json({ error: "already_called" }, 409);

  const called = [...g.called, number];
  const set = new Set(called);
  const p1Lines = countLines(g.p1Card, set);
  const p2Lines = countLines(g.p2Card, set);

  const over = p1Lines >= WIN_LINES || p2Lines >= WIN_LINES;
  const result: Game["result"] = !over
    ? null
    : p1Lines >= WIN_LINES && p2Lines >= WIN_LINES
      ? "draw"
      : p1Lines >= WIN_LINES
        ? "p1"
        : "p2";

  const next: Game = {
    ...g,
    called,
    p1Lines,
    p2Lines,
    turn: g.turn === "p1" ? "p2" : "p1",
    moveCount: g.moveCount + 1,
    status: over ? "finished" : "active",
    result,
    finishedAt: over ? new Date() : null,
  };

  const updated = await db
    .update(games)
    .set({
      called: next.called,
      p1Lines,
      p2Lines,
      turn: next.turn,
      moveCount: next.moveCount,
      status: next.status,
      result,
      finishedAt: next.finishedAt,
    })
    .where(and(eq(games.id, g.id), eq(games.moveCount, g.moveCount), eq(games.status, "active")))
    .returning({ id: games.id });
  if (updated.length === 0) return c.json({ error: "conflict" }, 409);

  return c.json(await toView(db, next, uid));
});

gamesRoute.post("/:id/resign", async (c) => {
  const db = c.get("db");
  const uid = c.get("userId");
  const res = await loadGame(db, c.req.param("id"), uid);
  if ("error" in res) return c.json({ error: res.error }, res.status);
  const g = res.game;
  if (g.status !== "active") return c.json(await toView(db, g, uid));

  const result = g.p1Id === uid ? "p2" : "p1";
  await db
    .update(games)
    .set({ status: "finished", result, finishedAt: new Date(), moveCount: g.moveCount + 1 })
    .where(and(eq(games.id, g.id), eq(games.status, "active")));

  const [fresh] = await db.select().from(games).where(eq(games.id, g.id));
  return c.json(await toView(db, fresh, uid));
});

export default gamesRoute;
