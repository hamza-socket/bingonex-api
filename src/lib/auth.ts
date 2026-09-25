import { sign, verify } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';
import type { AppEnv, Bindings } from '../types';

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const DEFAULT_JWT_SECRET = 'ldkjgioh9428*&*(#Ojfowej';

function getJwtSecret(env: Partial<Bindings> | undefined): string {
  return env?.JWT_SECRET?.trim() || DEFAULT_JWT_SECRET;
}

export function issueToken(env: Partial<Bindings>, userId: string) {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: userId, iat: now, exp: now + TOKEN_TTL_SECONDS }, getJwtSecret(env));
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  try {
    const payload = await verify(token, getJwtSecret(c.env), 'HS256');
    c.set('userId', payload.sub as string);
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});
