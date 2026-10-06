
import { DurableObject } from "cloudflare:workers";
import type { z } from "zod";
import { MATCH_RESULT_TTL_MS, RETRY_INTERVAL_MS, TOKEN_TTL_MS } from "../lib/constants";
import { findPairs } from "../lib/matcher";
import { GAME_IDS, GAMES, getGame, type GameId } from "../types/registery";
import {
  ackSchema,
  cancelSchema,
  clientMessageSchema,
  joinSchema,
  playerAttachmentSchema,
  registerTokenSchema,
  statusQuerySchema,
} from "../types/schema";
import { MatchmakingStore } from "../lib/storage";
import type { Bindings, GameDefinition, Pair, QueueEntry, StoredMatch, UserId } from "../types/types";

const WS_OPEN = 1;

type Route = readonly [suffix: string, handler: (request: Request, url: URL) => Promise<Response>];

const invalidPayload = (): Response => Response.json({ error: "invalid_payload" }, { status: 400 });


async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S> | null> {
  const raw = await request.json().catch(() => null);
  const result = schema.safeParse(raw);

  return result.success ? (result.data as z.output<S>) : null;
}

function playerTag(gameId: string, userId: UserId): string {
  return `${gameId}:${encodeURIComponent(String(userId))}`;
}

function isExpired(game: GameDefinition, entry: QueueEntry, now: number): boolean {
  return game.queueTtlMs !== null && now - entry.joinedAt >= game.queueTtlMs;
}

export class MatchmakingRoom extends DurableObject<Bindings> {
  private readonly store: MatchmakingStore;
  private chain: Promise<unknown> = Promise.resolve();

  private readonly routes: readonly Route[] = [
    ["/internal/register-token", (request) => this.registerToken(request)],
    ["/internal/queue/join", (request) => this.join(request)],
    ["/internal/queue/status", (_request, url) => this.status(url)],
    ["/internal/queue/cancel", (request) => this.cancel(request)],
    ["/internal/queue/ack", (request) => this.ack(request)],
  ];

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.store = new MatchmakingStore(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = this.routes.find(([suffix]) => url.pathname.endsWith(suffix));
    if (route) return this.exclusive(() => route[1](request, url));
    if (request.headers.get("Upgrade") === "websocket") {
      return this.exclusive(() => this.upgrade(url));
    }
    return new Response("Not Found", { status: 404 });
  }

  

  async alarm(): Promise<void> {
    await this.exclusive(async () => {
      const now = Date.now();
      await this.store.purgeTokens(now);
      await this.store.purgeMatches(now - MATCH_RESULT_TTL_MS);
      await this.expireQueue(now);
      await this.runMatching(GAME_IDS, now);
      if (await this.store.hasWork()) {
        await this.ctx.storage.setAlarm(Date.now() + RETRY_INTERVAL_MS);
      }
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (!clientMessageSchema.safeParse(parsed).success) {
      ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
      return;
    }

    ws.send(JSON.stringify({ type: "cancelled" }));
    ws.close(1000, "cancelled");
    await this.removePlayer(ws);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.removePlayer(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.removePlayer(ws);
  }

  private async registerToken(request: Request): Promise<Response> {
    const body = await readJson(request, registerTokenSchema);
    if (!body) return invalidPayload();

    await this.store.putToken(body.token, {
      userId: body.userId,
      username: body.username,
      elo: body.elo,
      gameId: body.gameId,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
    await this.ensureAlarm();
    return Response.json({ success: true });
  }

  private async join(request: Request): Promise<Response> {
    const body = await readJson(request, joinSchema);
    if (!body) return invalidPayload();

    const now = Date.now();
    const pending = await this.store.getMatch(body.gameId, body.userId);
    if (pending) {
      if (now - pending.matchedAt < MATCH_RESULT_TTL_MS) {
        return Response.json({ status: "matched", match: pending });
      }
      await this.store.deleteMatch(body.gameId, body.userId);
    }

    const game = GAMES[body.gameId];
    const previous = await this.store.getQueueEntry(body.gameId, body.userId);
    const joinedAt =
      previous && !isExpired(game, previous, now) ? previous.joinedAt : now;

    await this.store.putQueueEntry({ ...body, joinedAt });
    await this.runMatching([body.gameId], now);
    await this.ensureAlarm();
    return this.statusOf(body.gameId, body.userId, Date.now());
  }

  private async status(url: URL): Promise<Response> {
    const query = statusQuerySchema.safeParse({
      gameId: url.searchParams.get("gameId"),
      userId: url.searchParams.get("userId"),
    });
    if (!query.success) return Response.json({ error: "invalid_query" }, { status: 400 });
    return this.statusOf(query.data.gameId, query.data.userId, Date.now());
  }

  private async cancel(request: Request): Promise<Response> {
    const body = await readJson(request, cancelSchema);
    if (!body) return invalidPayload();
    await this.store.deleteQueueEntry(body.gameId, body.userId);
    return Response.json({ success: true });
  }

  private async ack(request: Request): Promise<Response> {
    const body = await readJson(request, ackSchema);
    if (!body) return invalidPayload();
    const match = await this.store.getMatch(body.gameId, body.userId);
    if (match?.matchId === body.matchId) {
      await this.store.deleteMatch(body.gameId, body.userId);
    }
    return Response.json({ success: true });
  }

  private async upgrade(url: URL): Promise<Response> {
    const token = url.searchParams.get("token");
    if (!token) return new Response("Missing token", { status: 401 });

    const data = await this.store.getToken(token);
    if (!data) return new Response("Invalid token", { status: 401 });
    await this.store.deleteToken(token);

    const now = Date.now();
    if (now > data.expiresAt) return new Response("Token expired", { status: 401 });
    if (!getGame(data.gameId)) return new Response("Unknown game", { status: 400 });

    const queued = await this.store.getQueueEntry(data.gameId, data.userId);
    if (queued) return new Response("Already queued", { status: 409 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [playerTag(data.gameId, data.userId)]);
    server.serializeAttachment({ gameId: data.gameId, userId: data.userId });

    const pending = await this.store.getMatch(data.gameId, data.userId);
    if (pending && now - pending.matchedAt < MATCH_RESULT_TTL_MS) {
      await this.store.deleteMatch(data.gameId, data.userId);
      server.send(JSON.stringify(pending.payload));
      server.close(1000, "matched");
      return new Response(null, { status: 101, webSocket: client });
    }

    await this.store.putQueueEntry({
      gameId: data.gameId,
      userId: data.userId,
      username: data.username,
      elo: data.elo,
      joinedAt: now,
    });
    server.send(JSON.stringify({ type: "queued" }));

    await this.runMatching([data.gameId as GameId], now);
    await this.ensureAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async statusOf(gameId: GameId, userId: UserId, now: number): Promise<Response> {
    const match = await this.store.getMatch(gameId, userId);
    if (match) {
      if (now - match.matchedAt < MATCH_RESULT_TTL_MS) {
        return Response.json({ status: "matched", match });
      }
      await this.store.deleteMatch(gameId, userId);
    }

    const entry = await this.store.getQueueEntry(gameId, userId);
    if (!entry) return Response.json({ status: "idle" });

    if (isExpired(GAMES[gameId], entry, now)) {
      await this.store.deleteQueueEntry(gameId, userId);
      return Response.json({ status: "idle" });
    }
    return Response.json({ status: "waiting" });
  }

  private async runMatching(gameIds: readonly GameId[], now: number): Promise<void> {
    for (const gameId of gameIds) {
      const game = GAMES[gameId];
      const queue = await this.store.listQueue(gameId);
      const live = queue.filter((entry) => !isExpired(game, entry, now));
      if (live.length < 2) continue;

      for (const pair of findPairs(live, game.matching, now)) {
        await this.settle(game, pair, now);
      }
    }
  }

  private async settle(game: GameDefinition, pair: Pair, now: number): Promise<void> {
    const matchId = crypto.randomUUID();
    const payloads = await game
      .onMatch({ env: this.env, matchId, players: pair })
      .catch((error: unknown) => {
        console.error("match_creation_failed", pair[0].gameId, matchId, error);
        return null;
      });
    if (!payloads) return;

    await this.store.deleteQueueEntries(pair);
    await Promise.all(
      pair.map((entry, index) =>
        this.deliver(entry, {
          matchId,
          gameId: entry.gameId,
          matchedAt: now,
          payload: { type: "matched", matchId, ...payloads[index] },
        }),
      ),
    );
  }

  private async deliver(entry: QueueEntry, match: StoredMatch): Promise<void> {
    if (this.push(entry, match.payload, "matched")) return;
    await this.store.putMatch(entry.gameId, entry.userId, match);
  }

  private async expireQueue(now: number): Promise<void> {
    const queue = await this.store.listQueue();
    const expired = queue.filter((entry) => {
      const game = getGame(entry.gameId);
      return !game || isExpired(game, entry, now);
    });
    if (expired.length === 0) return;

    await this.store.deleteQueueEntries(expired);
    for (const entry of expired) this.push(entry, { type: "expired" }, "expired");
  }

  private openSockets(gameId: string, userId: UserId): WebSocket[] {
    return this.ctx
      .getWebSockets(playerTag(gameId, userId))
      .filter((socket) => socket.readyState === WS_OPEN);
  }

  private push(entry: QueueEntry, message: object, reason: string): boolean {
    const text = JSON.stringify(message);
    let delivered = false;
    for (const socket of this.openSockets(entry.gameId, entry.userId)) {
      try {
        socket.send(text);
        socket.close(1000, reason);
        delivered = true;
      } catch (error) {
        console.error("push_failed", entry.gameId, error);
      }
    }
    return delivered;
  }

  private async removePlayer(ws: WebSocket): Promise<void> {
    const attachment = playerAttachmentSchema.safeParse(ws.deserializeAttachment());
    if (!attachment.success) return;
    const { gameId, userId } = attachment.data;

    await this.exclusive(async () => {
      if (this.openSockets(gameId, userId).length > 0) return;
      await this.store.deleteQueueEntry(gameId, userId);
    });
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + RETRY_INTERVAL_MS);
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation);
    this.chain = run.catch(() => undefined);
    return run;
  }
}