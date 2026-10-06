import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../db/schema";

export type Db = DrizzleD1Database<typeof schema>;

export type Bindings = {
  DB: D1Database;
  JWT_SECRET?: string;
  GOOGLE_CLIENT_IDS?: string;
  GAME_ROOMS: DurableObjectNamespace;
  MATCHMAKING_ROOM: DurableObjectNamespace;
};

export type Variables = { userId: string; db: Db };

export type AppEnv = { Bindings: Bindings; Variables: Variables };


export type UserId = string | number;

export type Payload = Record<string, unknown>;

export type QueueEntry = {
  gameId: string;
  userId: UserId;
  username: string;
  elo: number;
  joinedAt: number;
  metadata?: Record<string, unknown>;
};

export type TokenData = {
  userId: number;
  username: string;
  elo: number;
  gameId: string;
  expiresAt: number;
};

export type StoredMatch = {
  matchId: string;
  gameId: string;
  matchedAt: number;
  payload: Payload;
};

export type Pair = readonly [QueueEntry, QueueEntry];

export type EloOptions = {
  baseRange: number;
  step: number;
  stepIntervalMs: number;
  maxRange: number;
  fallbackMs: number;
};

export type MatchingConfig = ({ strategy: "elo-range" } & EloOptions) | { strategy: "fifo" };

export type MatchContext = {
  env: Bindings;
  matchId: string;
  players: Pair;
};

export type GameDefinition = {
  matching: MatchingConfig;
  queueTtlMs: number | null;
  onMatch: (context: MatchContext) => Promise<readonly [Payload, Payload]>;
};