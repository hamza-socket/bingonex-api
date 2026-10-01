import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  googleSub: text("google_sub").unique(),
  email: text("email"),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  isGuest: integer("is_guest", { mode: "boolean" }).notNull().default(false),
  rating: integer("rating").notNull().default(1000),
  allowSpectate: integer("allow_spectate", { mode: "boolean" }).notNull().default(true),
  bannedAt: integer("banned_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const refreshTokens = sqliteTable("refresh_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  replacedBy: text("replaced_by"),
});

export const playerStats = sqliteTable("player_stats", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  draws: integer("draws").notNull().default(0),
  rating: integer("rating").notNull().default(1000),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const matchQueue = sqliteTable("match_queue", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  card: text("card", { mode: "json" }).$type<number[]>().notNull(),
  createdAt: integer("created_at").notNull(),
});

export const games = sqliteTable(
  "games",
  {
    id: text("id").primaryKey(),
    p1Id: text("p1_id")
      .notNull()
      .references(() => users.id),
    p2Id: text("p2_id")
      .notNull()
      .references(() => users.id),
    p1Card: text("p1_card", { mode: "json" }).$type<number[]>().notNull(),
    p2Card: text("p2_card", { mode: "json" }).$type<number[]>().notNull(),
    called: text("called", { mode: "json" })
      .$type<number[]>()
      .notNull()
      .$defaultFn(() => []),
    turn: text("turn", { enum: ["p1", "p2"] })
      .notNull()
      .default("p1"),
    p1Lines: integer("p1_lines").notNull().default(0),
    p2Lines: integer("p2_lines").notNull().default(0),
    moveCount: integer("move_count").notNull().default(0),
    status: text("status", { enum: ["active", "finished"] })
      .notNull()
      .default("active"),
    result: text("result", { enum: ["p1", "p2", "draw"] }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("games_p1_idx").on(t.p1Id), index("games_p2_idx").on(t.p2Id)],
);

export type Game = typeof games.$inferSelect;
