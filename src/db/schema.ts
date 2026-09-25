import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  googleSub: text('google_sub').unique(), // null for guests
  email: text('email'),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  isGuest: integer('is_guest', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Replaces Firebase "Request" node. Multiple players can wait at once.
export const matchQueue = sqliteTable('match_queue', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  card: text('card', { mode: 'json' }).$type<number[]>().notNull(),
  createdAt: integer('created_at').notNull(), // epoch ms
});

// Replaces Firebase "Games" node. Wins/losses/draws are derived from here,
// so they can never drift out of sync.
export const games = sqliteTable(
  'games',
  {
    id: text('id').primaryKey(),
    p1Id: text('p1_id').notNull().references(() => users.id),
    p2Id: text('p2_id').notNull().references(() => users.id),
    p1Card: text('p1_card', { mode: 'json' }).$type<number[]>().notNull(),
    p2Card: text('p2_card', { mode: 'json' }).$type<number[]>().notNull(),
    called: text('called', { mode: 'json' }).$type<number[]>().notNull().$defaultFn(() => []),
    turn: text('turn', { enum: ['p1', 'p2'] }).notNull().default('p1'),
    p1Lines: integer('p1_lines').notNull().default(0),
    p2Lines: integer('p2_lines').notNull().default(0),
    moveCount: integer('move_count').notNull().default(0), // optimistic-lock version
    status: text('status', { enum: ['active', 'finished'] }).notNull().default('active'),
    result: text('result', { enum: ['p1', 'p2', 'draw'] }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('games_p1_idx').on(t.p1Id), index('games_p2_idx').on(t.p2Id)],
);

export type Game = typeof games.$inferSelect;
