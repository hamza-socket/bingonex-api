import { DurableObject } from "cloudflare:workers";
import { createSerializer } from "../lib/serial-queue";

export const GAME_IDS = ["ttt", "bingo"] as const;
export type GameId = (typeof GAME_IDS)[number];

type Env = {
  TTT_ROOM: DurableObjectNamespace;
  BINGO_ROOM: DurableObjectNamespace;
};

type QueueEntry = {
  gameId: GameId;
  userId: string;
  username: string;
  elo: number;
  joinedAt: number;
  connId?: string;
  metadata?: Record<string, unknown>;
};

type Opponent = { userId: string; username: string; elo: number };

type Assignment = {
  matchId: string;
  gameId: GameId;
  matchedAt: number;
  roomId: string;
  token: string;
  side: "X" | "O" | "p1" | "p2";
  opponent: Opponent;
};

type TokenData = {
  userId: string;
  username: string;
  elo: number;
  gameId: GameId;
  expiresAt: number;
};

const BASE_RANGE = 100;
const STEP = 50;
const STEP_INTERVAL_MS = 10_000;
const MAX_RANGE = 400;
const FALLBACK_MS = 90_000;
const RETRY_INTERVAL_MS = 5_000;
const QUEUE_ENTRY_TTL_MS = 5 * 60_000;
const MATCH_RESULT_TTL_MS = 2 * 60 * 60_000;
const TOKEN_TTL_MS = 60_000;

function getAllowedRange(waitMs: number): number {
  if (waitMs >= FALLBACK_MS) return Infinity;
  const steps = Math.floor(waitMs / STEP_INTERVAL_MS);
  return Math.min(BASE_RANGE + steps * STEP, MAX_RANGE);
}

const queueKey = (gameId: GameId, userId: number | string): string => `${gameId}:${userId}`;

function parseGameId(value: unknown): GameId | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (GAME_IDS as readonly string[]).includes(normalized) ? (normalized as GameId) : null;
}

function parseUserId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseEntry(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  const gameId = parseGameId(raw.gameId);
  const userId = parseUserId(raw.userId);
  const { username, elo, metadata } = raw;
  if (!gameId || userId === null) return null;
  if (typeof username !== "string" || username.length === 0) return null;
  if (typeof elo !== "number" || !Number.isFinite(elo)) return null;
  if (
    metadata !== undefined &&
    (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
  ) {
    return null;
  }
  return { gameId, userId, username, elo, metadata: metadata as Record<string, unknown> | undefined };
}

export class MatchmakingRoom extends DurableObject<Env> {
  private run = createSerializer();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const routes: Record<string, () => Promise<Response>> = {
      "/internal/register-token": () => this.handleRegisterToken(request),
      "/internal/queue/join": () => this.handleQueueJoin(request),
      "/internal/queue/status": () => this.handleQueueStatus(url),
      "/internal/queue/cancel": () => this.handleQueueCancel(request),
      "/internal/queue/ack": () => this.handleQueueAck(request),
    };

    const suffix = Object.keys(routes).find((route) => url.pathname.endsWith(route));
    if (suffix) return this.run(routes[suffix]);

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.run(() => this.handleUpgrade(url));
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.run(async () => {
      await this.matchLocked();
      await this.pruneTokens();
      const queue = await this.getMap<QueueEntry>("queue");
      if (Object.keys(queue).length > 0) {
        await this.ctx.storage.setAlarm(Date.now() + RETRY_INTERVAL_MS);
      }
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.run(async () => {
      try {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        const data = JSON.parse(text) as { type?: string };
        if (data?.type === "cancel") {
          await this.dropSocketEntry(ws);
          this.safeSend(ws, { type: "cancelled" });
          ws.close(1000, "cancelled");
        } else {
          this.safeSend(ws, { type: "error", message: "Unknown message type" });
        }
      } catch (err) {
        this.safeSend(ws, {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.run(() => this.dropSocketEntry(ws));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.run(() => this.dropSocketEntry(ws));
  }

  private async getMap<T>(key: string): Promise<Record<string, T>> {
    return (await this.ctx.storage.get<Record<string, T>>(key)) ?? {};
  }

  private async armAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + RETRY_INTERVAL_MS);
    }
  }

  private async pruneTokens(): Promise<void> {
    const tokens = await this.getMap<TokenData>("tokens");
    const now = Date.now();
    let dirty = false;
    for (const [token, data] of Object.entries(tokens)) {
      if (data.expiresAt <= now) {
        delete tokens[token];
        dirty = true;
      }
    }
    if (dirty) await this.ctx.storage.put("tokens", tokens);
  }

  private safeSend(ws: WebSocket, payload: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {}
  }

  private notify(key: string, payload: Record<string, unknown>): void {
    for (const ws of this.ctx.getWebSockets(key)) {
      this.safeSend(ws, payload);
      try {
        ws.close(1000, String(payload.type));
      } catch {}
    }
  }

  private matchedPayload(assignment: Assignment): Record<string, unknown> {
    return {
      type: "matched",
      ...assignment,
      ...(assignment.gameId === "ttt" ? { symbol: assignment.side } : {}),
    };
  }

  private async handleRegisterToken(request: Request): Promise<Response> {
    const body = await request.json<Record<string, unknown>>().catch(() => null);
    if (!body) return Response.json({ error: "invalid_payload" }, { status: 400 });

    const { token, username, elo } = body;
    const gameId = parseGameId(body.gameId);
    const userId = parseUserId(body.userId);
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      !gameId ||
      userId === null ||
      typeof username !== "string" ||
      username.length === 0 ||
      typeof elo !== "number" ||
      !Number.isFinite(elo)
    ) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }

    const tokens = await this.getMap<TokenData>("tokens");
    const now = Date.now();
    for (const [existing, data] of Object.entries(tokens)) {
      if (data.expiresAt <= now) delete tokens[existing];
    }
    tokens[token] = { userId, username, elo, gameId, expiresAt: now + TOKEN_TTL_MS };
    await this.ctx.storage.put("tokens", tokens);

    return Response.json({ success: true });
  }

  private async handleQueueJoin(request: Request): Promise<Response> {
    const entry = parseEntry(await request.json().catch(() => null));
    if (!entry) return Response.json({ error: "invalid_payload" }, { status: 400 });

    const key = queueKey(entry.gameId, entry.userId);
    const now = Date.now();

    const matches = await this.getMap<Assignment>("matches");
    const existing = matches[key];
    if (existing) {
      if (now - existing.matchedAt < MATCH_RESULT_TTL_MS) {
        return Response.json({ status: "matched", match: existing });
      }
      delete matches[key];
      await this.ctx.storage.put("matches", matches);
    }

    const queue = await this.getMap<QueueEntry>("queue");
    const previous = queue[key];
    const joinedAt =
      previous && now - previous.joinedAt < QUEUE_ENTRY_TTL_MS ? previous.joinedAt : now;
    queue[key] = { ...entry, joinedAt, connId: previous?.connId };
    await this.ctx.storage.put("queue", queue);

    await this.matchLocked();
    await this.armAlarm();
    return this.statusResponse(key);
  }

  private async handleQueueStatus(url: URL): Promise<Response> {
    const gameId = parseGameId(url.searchParams.get("gameId"));
    const userId = parseUserId(url.searchParams.get("userId"));
    if (!gameId || userId === null) {
      return Response.json({ error: "invalid_query" }, { status: 400 });
    }
    return this.statusResponse(queueKey(gameId, userId));
  }

  private async statusResponse(key: string): Promise<Response> {
    const now = Date.now();
    const matches = await this.getMap<Assignment>("matches");
    const match = matches[key];
    if (match) {
      if (now - match.matchedAt < MATCH_RESULT_TTL_MS) {
        return Response.json({ status: "matched", match });
      }
      delete matches[key];
      await this.ctx.storage.put("matches", matches);
    }

    const queue = await this.getMap<QueueEntry>("queue");
    const entry = queue[key];
    if (entry && now - entry.joinedAt >= QUEUE_ENTRY_TTL_MS) {
      delete queue[key];
      await this.ctx.storage.put("queue", queue);
      return Response.json({ status: "idle" });
    }
    return Response.json({ status: entry ? "waiting" : "idle" });
  }

  private async handleQueueCancel(request: Request): Promise<Response> {
    const body = await request.json<Record<string, unknown>>().catch(() => null);
    const gameId = parseGameId(body?.gameId);
    const userId = parseUserId(body?.userId);
    if (!gameId || userId === null) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }

    const key = queueKey(gameId, userId);
    const queue = await this.getMap<QueueEntry>("queue");
    delete queue[key];
    await this.ctx.storage.put("queue", queue);
    this.notify(key, { type: "cancelled" });
    return Response.json({ success: true });
  }

  private async handleQueueAck(request: Request): Promise<Response> {
    const body = await request.json<Record<string, unknown>>().catch(() => null);
    const gameId = parseGameId(body?.gameId);
    const userId = parseUserId(body?.userId);
    if (!gameId || userId === null || typeof body?.matchId !== "string" || !body.matchId) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }

    const key = queueKey(gameId, userId);
    const matches = await this.getMap<Assignment>("matches");
    if (matches[key]?.matchId === body.matchId) {
      delete matches[key];
      await this.ctx.storage.put("matches", matches);
    }
    return Response.json({ success: true });
  }

  private async handleUpgrade(url: URL): Promise<Response> {
    const token = url.searchParams.get("token");
    if (!token) return new Response("Missing token", { status: 401 });

    const tokens = await this.getMap<TokenData>("tokens");
    const data = tokens[token];
    if (!data) return new Response("Invalid token", { status: 401 });

    delete tokens[token];
    await this.ctx.storage.put("tokens", tokens);

    const now = Date.now();
    if (now > data.expiresAt) return new Response("Token expired", { status: 401 });

    const key = queueKey(data.gameId, data.userId);
    const connId = crypto.randomUUID();

    for (const old of this.ctx.getWebSockets(key)) {
      try {
        old.close(1000, "replaced");
      } catch {}
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [key, connId]);

    const matches = await this.getMap<Assignment>("matches");
    const assignment = matches[key];
    if (assignment && now - assignment.matchedAt < MATCH_RESULT_TTL_MS) {
      this.safeSend(server, this.matchedPayload(assignment));
      server.close(1000, "matched");
      return new Response(null, { status: 101, webSocket: client });
    }

    const queue = await this.getMap<QueueEntry>("queue");
    const previous = queue[key];
    queue[key] = {
      gameId: data.gameId,
      userId: data.userId,
      username: data.username,
      elo: data.elo,
      joinedAt: previous && now - previous.joinedAt < QUEUE_ENTRY_TTL_MS ? previous.joinedAt : now,
      connId,
    };
    await this.ctx.storage.put("queue", queue);

    this.safeSend(server, { type: "queued" });

    await this.matchLocked();
    await this.armAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  private async dropSocketEntry(ws: WebSocket): Promise<void> {
    const [key, connId] = this.ctx.getTags(ws);
    if (!key || !connId) return;
    const queue = await this.getMap<QueueEntry>("queue");
    if (queue[key]?.connId === connId) {
      delete queue[key];
      await this.ctx.storage.put("queue", queue);
    }
  }

  private async matchLocked(): Promise<void> {
    const now = Date.now();
    const queue = await this.getMap<QueueEntry>("queue");
    const matches = await this.getMap<Assignment>("matches");
    const notices: Array<[string, Record<string, unknown>]> = [];
    let queueDirty = false;
    let matchesDirty = false;

    for (const [key, match] of Object.entries(matches)) {
      if (now - match.matchedAt >= MATCH_RESULT_TTL_MS) {
        delete matches[key];
        matchesDirty = true;
      }
    }

    for (const [key, entry] of Object.entries(queue)) {
      if (matches[key]) {
        delete queue[key];
        queueDirty = true;
      } else if (now - entry.joinedAt >= QUEUE_ENTRY_TTL_MS) {
        delete queue[key];
        queueDirty = true;
        notices.push([key, { type: "timeout" }]);
      }
    }

    const entries = Object.values(queue).sort((x, y) => x.joinedAt - y.joinedAt);
    const taken = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      const a = entries[i];
      const keyA = queueKey(a.gameId, a.userId);
      if (taken.has(keyA)) continue;

      let best: QueueEntry | null = null;
      let bestDiff = Infinity;

      for (let j = i + 1; j < entries.length; j++) {
        const b = entries[j];
        if (a.gameId !== b.gameId || taken.has(queueKey(b.gameId, b.userId))) continue;

        const allowed = Math.max(
          getAllowedRange(now - a.joinedAt),
          getAllowedRange(now - b.joinedAt),
        );
        const diff = Math.abs(a.elo - b.elo);
        if (diff <= allowed && diff < bestDiff) {
          best = b;
          bestDiff = diff;
        }
      }

      if (!best) continue;
      const keyB = queueKey(best.gameId, best.userId);

      try {
        const [forA, forB] = await this.createRoom(a, best);
        matches[keyA] = forA;
        matches[keyB] = forB;
        delete queue[keyA];
        delete queue[keyB];
        taken.add(keyA);
        taken.add(keyB);
        queueDirty = true;
        matchesDirty = true;
        notices.push([keyA, this.matchedPayload(forA)], [keyB, this.matchedPayload(forB)]);
      } catch (err) {
        console.error("room creation failed", err);
      }
    }

    if (matchesDirty) await this.ctx.storage.put("matches", matches);
    if (queueDirty) await this.ctx.storage.put("queue", queue);
    for (const [key, payload] of notices) this.notify(key, payload);
  }

  private async createRoom(a: QueueEntry, b: QueueEntry): Promise<[Assignment, Assignment]> {
    const matchId = crypto.randomUUID();
    const roomId = matchId;
    const matchedAt = Date.now();
    const isTtt = a.gameId === "ttt";
    const namespace = isTtt ? this.env.TTT_ROOM : this.env.BINGO_ROOM;
    const sides = isTtt ? (["X", "O"] as const) : (["p1", "p2"] as const);
    const players = Math.random() < 0.5 ? [a, b] : [b, a];
    const tokens = [crypto.randomUUID(), crypto.randomUUID()];
    const stub = namespace.get(namespace.idFromName(roomId));

    await Promise.all(
      players.map(async (player, index) => {
        const response = await stub.fetch("http://do/internal/register-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: tokens[index],
            userId: player.userId,
            username: player.username,
            elo: player.elo,
            metadata: player.metadata,
            roomId,
            ...(isTtt ? { symbol: sides[index] } : { side: sides[index] }),
          }),
        });
        if (!response.ok) {
          throw new Error(`register-token failed for ${a.gameId} player ${player.userId}`);
        }
      }),
    );

    const [first, second] = players;
    const toOpponent = (p: QueueEntry): Opponent => ({
      userId: p.userId,
      username: p.username,
      elo: p.elo,
    });

    const firstAssignment: Assignment = {
      matchId,
      gameId: a.gameId,
      matchedAt,
      roomId,
      token: tokens[0],
      side: sides[0],
      opponent: toOpponent(second),
    };
    const secondAssignment: Assignment = {
      matchId,
      gameId: a.gameId,
      matchedAt,
      roomId,
      token: tokens[1],
      side: sides[1],
      opponent: toOpponent(first),
    };

    return first === a
      ? [firstAssignment, secondAssignment]
      : [secondAssignment, firstAssignment];
  }
}