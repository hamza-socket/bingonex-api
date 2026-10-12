# Bingo API (Hono + Drizzle + Cloudflare Workers + D1)

Runs on Cloudflare's free tier. Server-authoritative: the server validates every move,
counts lines, decides the winner, and hides the opponent's card until the game ends.

## Setup
```bash
pnpm install
pnpm wrangler login
pnpm exec wrangler d1 create bingo     # paste the database_id into wrangler.jsonc
pnpm exec wrangler secret put JWT_SECRET
# edit GOOGLE_CLIENT_IDS in wrangler.jsonc (see below)

pnpm run db:generate
pnpm run db:migrate:remote
pnpm run deploy
```
Local dev: `cp .dev.vars.example .dev.vars && pnpm run db:migrate:local && pnpm run dev`

## Google login
1. Google Cloud Console -> APIs & Services -> Credentials -> create OAuth client IDs
   (Web, plus Android/iOS if native). Put all IDs, comma separated, in `GOOGLE_CLIENT_IDS`.
2. The app signs in with Google (Credential Manager / Google Sign-In / Google Identity Services),
   gets an **ID token**, and calls `POST /auth/google {"idToken": "..."}`.
3. Response is `{ token, user }`. Send `Authorization: Bearer <token>` on every other call.
   For Android, the ID token audience is your **Web** client ID (pass it as `serverClientId`).

## API
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | /auth/google | `{idToken}` | Login/sign-up |
| POST | /auth/guest | - | Anonymous account |
| GET | /me | - | `{user, stats:{wins,losses,draws}}` |
| PATCH | /me | `{name}` | Rename |
| POST | /matchmaking/join | `{card:[25 numbers, 1..25 each once]}` | -> `waiting` or `matched` |
| GET | /matchmaking/status | - | Poll ~2s: `idle / waiting / matched(gameId)` |
| DELETE | /matchmaking | - | Cancel search |
| GET | /games/active | - | Resume an unfinished game |
| GET | /games/:id | - | Poll ~1.5s. `yourTurn`, `called`, `yourLines`, `opponentLines`, `outcome` |
| POST | /games/:id/move | `{number}` | 409 on `not_your_turn` / `already_called` / `conflict` |
| POST | /games/:id/resign | - | Opponent wins |

Client tip: mark your own card locally from `called`; the winner is when `yourLines >= 5`
(server sets `status: "finished"` and `outcome`).

## Shared matchmaking
All games use one globally named `MatchmakingRoom` Durable Object. Queue entries include a
`gameId`, and the object only matches players with the same ID, so queues stay isolated while
sharing the same matchmaking service. Bingo uses the internal join/status/cancel/ack operations
and keeps its game-specific card and room setup in the Bingo routes. Tic-tac-toe keeps its
WebSocket/token flow. Future games can use the same queue operations with their own `gameId`
and metadata, then initialize their own game room from the returned match.

## Not included yet (good next steps)
- Realtime: swap polling for a Durable Object WebSocket per game (free plan supports SQLite-backed DOs).
- Auto-forfeit of abandoned games (add `updatedAt` + extend the cron).
- Rate limiting on `/auth/guest`, leaderboard endpoint.
