import { createMiddleware } from "hono/factory";
import { sign, verify } from "hono/jwt";
import type { AppEnv, Bindings } from "../types";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function getJwtSecret(env: Partial<Bindings> | undefined): string {
  const secret = env?.JWT_SECRET?.trim();

  if (!secret) {
    throw new Error("JWT_SECRET missing");
  }

  return secret;
}

export function issueToken(env: Partial<Bindings>, userId: string) {
  const now = Math.floor(Date.now() / 1000);

  return sign({ sub: userId, iat: now, exp: now + ACCESS_TOKEN_TTL_SECONDS }, getJwtSecret(env));
}

export function issueRefreshToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  return `refresh_${Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export async function hashRefreshToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createRefreshTokenRecord(userId: string) {
  const createdAt = Date.now();
  const token = issueRefreshToken();
  const hash = await hashRefreshToken(token);

  return {
    token,
    hash,
    userId,
    createdAt,
    expiresAt: createdAt + REFRESH_TOKEN_TTL_MS,
  };
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  try {
    const payload = await verify(token, getJwtSecret(c.env), "HS256");
    c.set("userId", payload.sub as string);
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }

  await next();
});
