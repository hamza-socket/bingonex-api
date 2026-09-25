import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import authRoutes from './routes/auth';
import meRoutes from './routes/me';
import matchmakingRoutes from './routes/matchmaking';
import gameRoutes from './routes/games';
import type { AppEnv, Bindings } from './types';

const app = new Hono<AppEnv>();

app.use('*', cors());
app.use('*', async (c, next) => {
  c.set('db', drizzle(c.env.DB, { schema }));
  await next();
});

app.get('/', (c) => c.json({ ok: true, service: 'bingo-api' }));
app.route('/auth', authRoutes);
app.route('/me', meRoutes);
app.route('/matchmaking', matchmakingRoutes);
app.route('/games', gameRoutes);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
});

export default {
  fetch: app.fetch,
  // Cron: drop players who left the "finding player" screen without cancelling.
  async scheduled(_event, env, ctx) {
    const db = drizzle(env.DB, { schema });
    ctx.waitUntil(db.delete(schema.matchQueue).where(lt(schema.matchQueue.createdAt, Date.now() - 5 * 60_000)));
  },
} satisfies ExportedHandler<Bindings>;
