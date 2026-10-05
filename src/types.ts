import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "./db/schema";

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
