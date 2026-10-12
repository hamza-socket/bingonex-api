# Bingo API

Backend for a multiplayer Bingo game. It runs on Cloudflare Workers, uses Hono
for HTTP routing, D1/SQLite for persistent data, and Durable Objects for
matchmaking and live game rooms.

This repository contains the backend, not a mobile client. Use this document as
the integration guide when building a mobile app against the deployed API.
Keep the app's API base URL configurable; the production URL is deployment
specific.

## What the mobile app should implement

1. Let a player sign in with Google or continue as a guest.
2. Keep the access token in secure device storage and attach it as a Bearer
   token to authenticated API requests.
3. Show the player's profile and record from `GET /me`.
4. Create a randomized 5×5 Bingo card containing each number from 1 through 25
   exactly once, then submit it to matchmaking.
5. While queued, show a waiting state and poll matchmaking status about every
   two seconds. Allow the player to cancel.
6. When matched, connect to the game's WebSocket and render server-sent game
   state. Do not decide turns, called numbers, line counts, or the winner in
   the client; the server is authoritative.
7. Reconnect by fetching the current game state and requesting a fresh
   connection token. Handle finished games, disconnects, and network errors
   without losing the signed-in session.

The app can use any native or cross-platform framework. Keep authentication,
HTTP, WebSocket, and game state handling separate from presentation so that
network reconnects and server state updates do not depend on a particular
screen being mounted.

## API conventions

- Base URL: the deployed Worker URL, configured per environment. Local Wrangler
  development normally listens on `http://localhost:8787`.
- JSON requests use `Content-Type: application/json`.
- Authenticated endpoints require the `Authorization` HTTP header with the
  `Bearer` scheme and the player's access token.
- The access token is a JWT that expires after 15 minutes. Google sign-in
  returns a refresh token; use `POST /auth/refresh` to rotate it before the
  access token expires. Store refresh tokens securely and replace the old one
  after a successful refresh. `POST /auth/guest` currently does not include a
  refresh token in its response, so guest sessions cannot use the refresh
  endpoint unless that API contract is changed.
- Successful and error responses are JSON unless an endpoint upgrades to a
  WebSocket. Errors generally have an `error` string; clients should handle
  non-2xx responses explicitly rather than treating them as success.

## Authentication and profile

| Method | Path | Auth | Request | Response / purpose |
|---|---|---|---|---|
| POST | `/auth/google` | No | `{"idToken":"<Google ID token>"}` | `{token, refreshToken, user}`; creates or signs in a Google account. |
| POST | `/auth/guest` | No | No body | `{token, user}`; creates an anonymous account. |
| POST | `/auth/refresh` | No | `{"refreshToken":"..."}` | `{token, refreshToken}`; rotates the refresh token. |
| POST | `/auth/logout` | No | `{"refreshToken":"..."}` | `{ok:true}`; revokes the supplied refresh token. |
| GET | `/me` | Yes | No body | `{user, stats}`; current profile and wins/losses/draws. |
| PATCH | `/me` | Yes | `{"name":"New name"}` and/or `{"allowSpectate":true}` | `{user}`; name is trimmed and limited to 30 characters. |

For Google sign-in, the app obtains an ID token using the platform's Google
Sign-In SDK and sends that ID token to the API. Configure the OAuth client IDs
on the backend; on Android, the ID token audience should be the Web client ID.
Never put backend secrets or service credentials in the mobile app.

## Bingo matchmaking and games

All of these routes require authentication.

| Method | Path | Request | Response / purpose |
|---|---|---|---|
| POST | `/matchmaking/join` | `{"card":[25 numbers]}` | `{status:"waiting"}` or `{status:"matched", gameId, token, side, opponent}`. |
| GET | `/matchmaking/status` | No body | `idle`, `waiting`, or the same matched assignment. |
| DELETE | `/matchmaking` | No body | `{ok:true}`; cancels the current search. |
| GET | `/games/active` | No body | `{gameId: string|null}`; returns the current matched game if any. |
| GET | `/games/:id` | No body | Current player-specific game state; useful for initial load and recovery. |
| POST | `/games/:id/connect` | No body | Issues a fresh `{roomId, token, side}` WebSocket credential for a player in that game. |
| GET | `/games/:id/ws` | WebSocket upgrade | Live game connection. |

The card is a flat array of exactly 25 unique integers, each in the range 1–25.
The API accepts the card as optional, but the mobile client should send one to
ensure the player uses the card displayed by the app. If omitted, the server
generates a card for the room.

Example join request:

```json
{
  "card": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]
}
```

Example match assignment:

```json
{
  "status": "matched",
  "gameId": "room-uuid",
  "token": "one-time-websocket-token",
  "side": "p1",
  "opponent": {
    "userId": "player-uuid",
    "username": "Player",
    "elo": 1000
  }
}
```

The assignment's `gameId` is the room ID. Connect to
`/games/{gameId}/ws?token={token}` with a WebSocket upgrade and the same
Bearer-authenticated `Authorization` header used for HTTP. The room token is
one-time-use; if the socket cannot be established or the client reconnects,
call `POST /games/{gameId}/connect` for a fresh token. Do not log or persist
these one-time connection tokens.

### Bingo WebSocket messages

Messages are JSON. The server sends a player-specific state envelope:

```json
{
  "v": 1,
  "t": "state",
  "state": {
    "id": "room-uuid",
    "side": "p1",
    "status": "active",
    "outcome": null,
    "yourTurn": true,
    "card": [1, 2, 3],
    "called": [],
    "lastCalled": null,
    "yourLines": 0,
    "opponentLines": 0,
    "opponent": {
      "id": "player-uuid",
      "name": "Player",
      "avatarUrl": null,
      "connected": true
    },
    "opponentCard": null,
    "moveCount": 0,
    "ratingChange": null
  }
}
```

The sample card is abbreviated; actual cards contain 25 numbers. `opponentCard`
is hidden until the game finishes. The full state also includes `endReason`
when applicable. Treat state messages as authoritative snapshots rather than
trying to infer or optimistically commit game outcomes on the client.

Client-to-server messages:

```json
{"type":"sync"}
{"type":"move","number":17}
{"type":"resign"}
```

`sync` requests a fresh state. A `move` can only call a number from 1–25 on the
player's turn and a number cannot be called twice. The server responds with
state updates, or an envelope such as
`{"v":1,"t":"error","message":"Not your turn"}`. A game ends when either player
has five completed rows, columns, or diagonals; resignation and disconnection
may also end the game. Handle `opponent_disconnected` and
`opponent_reconnected` notifications and reconnect when the network returns.

The authenticated HTTP game-state response includes the same essential
player-specific fields (`status`, `yourTurn`, `called`, line counts, outcome,
and opponent). `GET /games/active` and `GET /games/:id` can be used to restore
the game screen after app restart or navigation.

## Current project scope

The active Worker in `src/index.ts` mounts `/auth`, `/me`, `/matchmaking`, and
`/games`; the implemented mobile gameplay API described above is Bingo.
There is a Tic-Tac-Toe route file under `src/routes/ttt/`, but it is not mounted
by the Worker. Do not build mobile flows against those TTT endpoints unless the
backend is first wired up and its current contracts are verified.

## Backend development

Requirements: Node.js 20.11.x and pnpm.

```bash
pnpm install
cp .dev.vars.example .dev.vars
# Set a long random JWT_SECRET in .dev.vars for local development.
pnpm run db:migrate:local
pnpm run dev
```

Check that the D1 database name used by the migration command matches the
database configured in `wrangler.jsonc`. For deployment, configure the
Cloudflare D1 database, Durable Object bindings, `JWT_SECRET` secret, and
`GOOGLE_CLIENT_IDS` before running:

```bash
pnpm run db:migrate:remote
pnpm run deploy
```

Available checks:

```bash
pnpm run typecheck
pnpm test
pnpm run lint
```

## Architecture map

- `src/index.ts` — Worker entry point and mounted HTTP routes.
- `src/auth-routes/` — Google, guest, refresh, logout, and profile endpoints.
- `src/routes/bingo/` — Bingo matchmaking and game HTTP/WebSocket routes.
- `src/game-room-DOs/bingo-room.ts` — authoritative Bingo room state and
  WebSocket protocol.
- `src/matchmaking-DO/matching-room.ts` — Durable Object matchmaking queue.
- `src/db/schema.ts` and `drizzle/` — D1 schema and migrations.
- `wrangler.jsonc` — Cloudflare Worker, D1, Durable Object, and cron bindings.
