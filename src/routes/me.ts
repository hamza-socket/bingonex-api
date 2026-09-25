import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema';
import { requireAuth } from '../lib/auth';
import { getStats } from '../lib/stats';
import type { AppEnv } from '../types';

const me = new Hono<AppEnv>();
me.use('*', requireAuth);

me.get('/', async (c) => {
  const db = c.get('db');
  const uid = c.get('userId');
  const [user] = await db.select().from(users).where(eq(users.id, uid));
  if (!user) return c.json({ error: 'not_found' }, 404);
  return c.json({ user, stats: await getStats(db, uid) });
});

me.patch('/', zValidator('json', z.object({ name: z.string().trim().min(1).max(30) })), async (c) => {
  const [user] = await c
    .get('db')
    .update(users)
    .set({ name: c.req.valid('json').name })
    .where(eq(users.id, c.get('userId')))
    .returning();
  return c.json({ user });
});

export default me;
