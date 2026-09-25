import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { users } from '../db/schema';
import { issueToken } from '../lib/auth';
import type { AppEnv } from '../types';

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

const auth = new Hono<AppEnv>();

/**
 * The client (Android / iOS / web) signs in with Google natively and sends us
 * the resulting ID token. We verify it against Google's public keys and return
 * our own session token.
 */
auth.post('/google', zValidator('json', z.object({ idToken: z.string().min(1) })), async (c) => {
  const { idToken } = c.req.valid('json');

  const googleClientIds = (c.env.GOOGLE_CLIENT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: googleClientIds,
    }));
  } catch {
    return c.json({ error: 'invalid_google_token' }, 401);
  }

  const email = (payload.email as string | undefined) ?? null;
  const avatarUrl = (payload.picture as string | undefined) ?? null;
  const name = (payload.name as string | undefined) ?? email?.split('@')[0] ?? 'Player';

  // Name is only set on first login so players can rename themselves later.
  const [user] = await c
    .get('db')
    .insert(users)
    .values({ id: crypto.randomUUID(), googleSub: payload.sub!, email, name, avatarUrl })
    .onConflictDoUpdate({ target: users.googleSub, set: { email, avatarUrl } })
    .returning();

  return c.json({ token: await issueToken(c.env, user.id), user });
});

/** Replacement for Firebase anonymous auth. */
auth.post('/guest', async (c) => {
  const [user] = await c
    .get('db')
    .insert(users)
    .values({ id: crypto.randomUUID(), name: 'Guest Player', isGuest: true })
    .returning();
  return c.json({ token: await issueToken(c.env, user.id), user });
});

export default auth;
