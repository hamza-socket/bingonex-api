import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { refreshTokens, users } from "../db/schema";
import { createRefreshTokenRecord, hashRefreshToken, issueToken } from "../lib/auth";
import type { AppEnv } from "../types";

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

const auth = new Hono<AppEnv>();

async function storeRefreshToken(db: AppEnv["Variables"]["db"], userId: string) {
  const record = await createRefreshTokenRecord(userId);

  await db.insert(refreshTokens).values({
    tokenHash: record.hash,
    userId: record.userId,
    createdAt: new Date(record.createdAt),
    expiresAt: new Date(record.expiresAt),
  });

  return record;
}

auth.post("/google", zValidator("json", z.object({ idToken: z.string().min(1) })), async (c) => {
  const { idToken } = c.req.valid("json");

  const googleClientIds = (c.env.GOOGLE_CLIENT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  type GooglePayload = {
    sub?: string;
    email?: string | null;
    picture?: string | null;
    name?: string | null;
  };

  let verification: { payload: GooglePayload } | undefined;

  try {
    verification = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: googleClientIds,
    });
  } catch {
    return c.json({ error: "invalid_google_token" }, 401);
  }

  const payload = verification.payload;

  if (!payload.sub) {
    return c.json({ error: "invalid_google_token" }, 401);
  }

  const email = payload.email ?? null;
  const avatarUrl = payload.picture ?? null;
  const name = payload.name ?? email?.split("@")[0] ?? "Player";

  const [user] = await c
    .get("db")
    .insert(users)
    .values({ id: crypto.randomUUID(), googleSub: payload.sub, email, name, avatarUrl })
    .onConflictDoUpdate({ target: users.googleSub, set: { email, avatarUrl } })
    .returning();

  const refresh = await storeRefreshToken(c.get("db"), user.id);

  return c.json({ token: await issueToken(c.env, user.id), refreshToken: refresh.token, user });
});

auth.post("/guest", async (c) => {
  const [user] = await c
    .get("db")
    .insert(users)
    .values({ id: crypto.randomUUID(), name: "Guest Player", isGuest: true })
    .returning();

  const _refresh = await storeRefreshToken(c.get("db"), user.id);
  void _refresh;

  return c.json({ token: await issueToken(c.env, user.id), user });
});

auth.post(
  "/refresh",
  zValidator("json", z.object({ refreshToken: z.string().min(1) })),
  async (c) => {
    const { refreshToken } = c.req.valid("json");
    const tokenHash = await hashRefreshToken(refreshToken);
    const db = c.get("db");

    const [record] = await db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));

    if (!record || record.expiresAt.getTime() < Date.now()) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const nextRecord = await createRefreshTokenRecord(record.userId);

    await db.transaction(async (tx) => {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date(), replacedBy: nextRecord.hash })
        .where(eq(refreshTokens.tokenHash, tokenHash));

      await tx.insert(refreshTokens).values({
        tokenHash: nextRecord.hash,
        userId: record.userId,
        createdAt: new Date(nextRecord.createdAt),
        expiresAt: new Date(nextRecord.expiresAt),
      });
    });

    return c.json({
      token: await issueToken(c.env, record.userId),
      refreshToken: nextRecord.token,
    });
  },
);

auth.post(
  "/logout",
  zValidator("json", z.object({ refreshToken: z.string().min(1) })),
  async (c) => {
    const { refreshToken } = c.req.valid("json");
    const tokenHash = await hashRefreshToken(refreshToken);
    const db = c.get("db");

    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));

    return c.json({ ok: true });
  },
);

export default auth;
