import { lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { cors } from "hono/cors";
import * as schema from "./db/schema";
import { GameRoom } from "./durable-object/game-room";
import authRoutes from "./routes/auth";
import gameRoutes from "./routes/games";
import matchmakingRoutes from "./routes/matchmaking";
import meRoutes from "./routes/me";
import type { AppEnv, Bindings } from "./types";

const app = new Hono<AppEnv>();

app.use("*", cors());
app.use("*", async (c, next) => {
  c.set("db", drizzle(c.env.DB, { schema }));
  await next();
});

app.get("/", (c) => c.json({ ok: true, service: "bingo-api" }));
app.route("/auth", authRoutes);
app.route("/me", meRoutes);
app.route("/matchmaking", matchmakingRoutes);
app.route("/games", gameRoutes);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

export { GameRoom };

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    const db = drizzle(env.DB, { schema });
    ctx.waitUntil(
      db.delete(schema.matchQueue).where(lt(schema.matchQueue.createdAt, Date.now() - 5 * 60_000)),
    );
  },
} satisfies ExportedHandler<Bindings>;
