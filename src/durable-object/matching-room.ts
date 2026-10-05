import { DurableObject } from "cloudflare:workers";

type QueueEntry = {
  gameId: string;
  userId: string | number;
  username: string;
  elo: number;
  joinedAt: number;
  metadata?: Record<string, unknown>;
};

type TokenData = {
  userId: number;
  username: string;
  elo: number;
  gameId: string;
  expiresAt: number;
};

type MatchResult = {
  matchId: string;
  gameId: string;
  matchedAt: number;
  players: [QueueEntry, QueueEntry];
};

type Bindings = {
  GAME_ROOM: DurableObjectNamespace;
};

type DurableObjectStateWithAlarm = DurableObjectState & {
  setAlarm(alarm: number): Promise<void>;
};

const BASE_RANGE = 100;
const STEP = 50;
const STEP_INTERVAL_MS = 10_000;
const MAX_RANGE = 400;
const FALLBACK_MS = 90_000;
const RETRY_INTERVAL_MS = 5_000;
const QUEUE_ENTRY_TTL_MS = 5 * 60_000;
const MATCH_RESULT_TTL_MS = 10 * 60_000;
const TTT_GAME_ID = "tic-tac-toe";

function getAllowedRange(waitMs: number): number {
  if (waitMs >= FALLBACK_MS) return Infinity;
  const steps = Math.floor(waitMs / STEP_INTERVAL_MS);
  return Math.min(BASE_RANGE + steps * STEP, MAX_RANGE);
}

function getQueueKey(gameId: string, userId: string | number): string {
  return JSON.stringify([gameId, String(userId)]);
}

function isQueueEntry(value: unknown): value is Omit<QueueEntry, "joinedAt"> {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.gameId === "string" &&
    entry.gameId.length > 0 &&
    ((typeof entry.userId === "string" && entry.userId.length > 0) ||
      (typeof entry.userId === "number" && Number.isFinite(entry.userId))) &&
    typeof entry.username === "string" &&
    entry.username.length > 0 &&
    typeof entry.elo === "number" &&
    Number.isFinite(entry.elo) &&
    (entry.metadata === undefined ||
      (typeof entry.metadata === "object" &&
        entry.metadata !== null &&
        !Array.isArray(entry.metadata)))
  );
}

export class MatchmakingRoom extends DurableObject {
  private matchmakingEnv: Bindings;
  private operationChain = Promise.resolve();

  constructor(
    private state: DurableObjectStateWithAlarm,
    env: Bindings,
  ) {
    super(state, env);
    this.matchmakingEnv = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/internal/register-token")) {
      return this.serialize(() => this.handleRegisterToken(request));
    }
    if (url.pathname.endsWith("/internal/queue/join")) {
      return this.serialize(() => this.handleQueueJoin(request));
    }
    if (url.pathname.endsWith("/internal/queue/status")) {
      return this.serialize(() => this.handleQueueStatus(url));
    }
    if (url.pathname.endsWith("/internal/queue/cancel")) {
      return this.serialize(() => this.handleQueueCancel(request));
    }
    if (url.pathname.endsWith("/internal/queue/ack")) {
      return this.serialize(() => this.handleQueueAck(request));
    }

    if (request.headers.get("Upgrade") === "websocket") {
      return this.serialize(() => this.handleWebSocketUpgrade(request));
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.tryMatch();

    const queue = (await this.state.storage.get<Record<string, QueueEntry>>("queue")) ?? {};
    const matches = (await this.state.storage.get<Record<string, MatchResult>>("matches")) ?? {};
    if (Object.keys(queue).length > 0 || Object.keys(matches).length > 0) {
      await this.state.setAlarm(Date.now() + RETRY_INTERVAL_MS);
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const data = JSON.parse(String(message));
      if (data.type === "cancel") {
        await this.removePlayer(ws);
        ws.send(JSON.stringify({ type: "cancelled" }));
        ws.close();
      } else {
        ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
      }
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.removePlayer(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.removePlayer(ws);
  }

  private async handleRegisterToken(request: Request): Promise<Response> {
    const body = await request.json<{
      token?: string;
      userId?: number;
      username?: string;
      elo?: number;
      gameId?: string;
    }>();
    if (
      !body.token ||
      typeof body.userId !== "number" ||
      !body.username ||
      typeof body.elo !== "number" ||
      !Number.isFinite(body.elo)
    ) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }

    const tokens = (await this.state.storage.get<Record<string, TokenData>>("tokens")) ?? {};
    const now = Date.now();
    for (const [token, tokenData] of Object.entries(tokens)) {
      if (tokenData.expiresAt <= now) delete tokens[token];
    }
    tokens[body.token] = {
      userId: body.userId,
      username: body.username,
      elo: body.elo,
      gameId: body.gameId || TTT_GAME_ID,
      expiresAt: now + 60 * 1000,
    };
    await this.state.storage.put("tokens", tokens);

    return Response.json({ success: true });
  }

  private async handleQueueJoin(request: Request): Promise<Response> {
    const body = await request.json<{
      gameId?: string;
      userId?: string | number;
      username?: string;
      elo?: number;
      metadata?: Record<string, unknown>;
    }>();
    if (!isQueueEntry(body)) return Response.json({ error: "invalid_payload" }, { status: 400 });

    const queue = (await this.state.storage.get<Record<string, QueueEntry>>("queue")) ?? {};
    const key = getQueueKey(body.gameId, body.userId);
    const matches = (await this.state.storage.get<Record<string, MatchResult>>("matches")) ?? {};
    const existingMatch = matches[key];
    if (existingMatch && Date.now() - existingMatch.matchedAt < MATCH_RESULT_TTL_MS) {
      return Response.json({ status: "matched", match: existingMatch });
    }
    if (existingMatch) {
      delete matches[key];
      await this.state.storage.put("matches", matches);
    }
    const now = Date.now();
    const previous = queue[key];
    const joinedAt =
      previous && (body.gameId === TTT_GAME_ID || now - previous.joinedAt < QUEUE_ENTRY_TTL_MS)
        ? previous.joinedAt
        : now;
    queue[key] = { ...body, joinedAt };
    await this.state.storage.put("queue", queue);

    await this.tryMatchLocked();
    await this.state.setAlarm(Date.now() + RETRY_INTERVAL_MS);
    return this.handleQueueStatus(
      new URL(
        `http://do/internal/queue/status?gameId=${encodeURIComponent(body.gameId)}&userId=${encodeURIComponent(String(body.userId))}`,
      ),
    );
  }

  private async handleQueueStatus(url: URL): Promise<Response> {
    const gameId = url.searchParams.get("gameId");
    const userId = url.searchParams.get("userId");
    if (!gameId || !userId) return Response.json({ error: "invalid_query" }, { status: 400 });

    const key = getQueueKey(gameId, userId);
    const matches = (await this.state.storage.get<Record<string, MatchResult>>("matches")) ?? {};
    const match = matches[key];
    if (match && Date.now() - match.matchedAt < MATCH_RESULT_TTL_MS) {
      return Response.json({ status: "matched", match });
    }
    if (match) {
      delete matches[key];
      await this.state.storage.put("matches", matches);
    }

    const queue = (await this.state.storage.get<Record<string, QueueEntry>>("queue")) ?? {};
    const entry = queue[key];
    if (
      entry &&
      entry.gameId !== TTT_GAME_ID &&
      Date.now() - entry.joinedAt >= QUEUE_ENTRY_TTL_MS
    ) {
      delete queue[key];
      await this.state.storage.put("queue", queue);
      return Response.json({ status: "idle" });
    }
    return Response.json({ status: queue[key] ? "waiting" : "idle" });
  }

  private async handleQueueCancel(request: Request): Promise<Response> {
    const body = await request.json<{ gameId?: string; userId?: string | number }>();
    if (!body.gameId || body.userId === undefined) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    const queue = (await this.state.storage.get<Record<string, QueueEntry>>("queue")) ?? {};
    delete queue[getQueueKey(body.gameId, body.userId)];
    await this.state.storage.put("queue", queue);
    return Response.json({ success: true });
  }

  private async handleQueueAck(request: Request): Promise<Response> {
    const body = await request.json<{
      gameId?: string;
      userId?: string | number;
      matchId?: string;
    }>();
    if (!body.gameId || body.userId === undefined || !body.matchId) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    const matches = (await this.state.storage.get<Record<string, MatchResult>>("matches")) ?? {};
    const key = getQueueKey(body.gameId, body.userId);
    if (matches[key]?.matchId === body.matchId) {
      delete matches[key];
      await this.state.storage.put("matches", matches);
    }
    return Response.json({ success: true });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");

    if (!token) return new Response("Missing token", { status: 401 });

    const tokens = (await this.state.storage.get<Record<string, TokenData>>("tokens")) ?? {};
    const tokenData = tokens[token];

    if (!tokenData) return new Response("Invalid token", { status: 401 });
    if (Date.now() > tokenData.expiresAt) return new Response("Token expired", { status: 401 });

    delete tokens[token];
    await this.state.storage.put("tokens", tokens);

    const queue = (await this.state.storage.get<Record<string, QueueEntry>>("queue")) ?? {};
    const queueKey = getQueueKey(tokenData.gameId, tokenData.userId);
    if (queue[queueKey]) return new Response("Already queued", { status: 409 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server, [tokenData.gameId, String(tokenData.userId)]);

    queue[queueKey] = {
      gameId: tokenData.gameId,
      userId: tokenData.userId,
      username: tokenData.username,
      elo: tokenData.elo,
      joinedAt: Date.now(),
    };
    await this.state.storage.put("queue", queue);

    server.send(JSON.stringify({ type: "queued" }));

    await this.tryMatchLocked();
    await this.state.setAlarm(Date.now() + RETRY_INTERVAL_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async removePlayer(ws: WebSocket): Promise<void> {
    const [gameId, userId] = this.state.getTags(ws);
    if (!gameId || !userId) return;

    await this.serialize(async () => {
      const queue = (await this.state.storage.get<Record<string, QueueEntry>>("queue")) ?? {};
      delete queue[getQueueKey(gameId, userId)];
      await this.state.storage.put("queue", queue);
    });
  }

  private async tryMatch(): Promise<void> {
    await this.serialize(() => this.tryMatchLocked());
  }

  private async tryMatchLocked(): Promise<void> {
    const queue = (await this.state.storage.get<Record<string, QueueEntry>>("queue")) ?? {};
    const matches = (await this.state.storage.get<Record<string, MatchResult>>("matches")) ?? {};
    let removedMatchedPlayers = false;
    const now = Date.now();
    let removedExpiredMatches = false;
    for (const [key, match] of Object.entries(matches)) {
      if (now - match.matchedAt >= MATCH_RESULT_TTL_MS) {
        delete matches[key];
        removedExpiredMatches = true;
      }
    }
    if (removedExpiredMatches) await this.state.storage.put("matches", matches);
    for (const key of Object.keys(queue)) {
      const entry = queue[key];
      if (
        matches[key] ||
        (entry.gameId !== TTT_GAME_ID && now - entry.joinedAt >= QUEUE_ENTRY_TTL_MS)
      ) {
        delete queue[key];
        removedMatchedPlayers = true;
      }
    }
    if (removedMatchedPlayers) await this.state.storage.put("queue", queue);

    const entries = Object.values(queue).sort((a, b) => a.joinedAt - b.joinedAt);
    const matchedKeys = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      const a = entries[i];
      const keyA = getQueueKey(a.gameId, a.userId);
      if (matchedKeys.has(keyA)) continue;

      let bestMatch: QueueEntry | null = null;
      let bestDiff = Infinity;

      for (let j = i + 1; j < entries.length; j++) {
        const b = entries[j];
        const keyB = getQueueKey(b.gameId, b.userId);
        if (a.gameId !== b.gameId || matchedKeys.has(keyB)) continue;

        const rangeA = getAllowedRange(now - a.joinedAt);
        const rangeB = getAllowedRange(now - b.joinedAt);
        const allowedRange = Math.max(rangeA, rangeB);
        const diff = Math.abs(a.elo - b.elo);

        if (diff <= allowedRange && diff < bestDiff) {
          bestMatch = b;
          bestDiff = diff;
        }
      }

      if (bestMatch) {
        const keyB = getQueueKey(bestMatch.gameId, bestMatch.userId);
        matchedKeys.add(keyA);
        matchedKeys.add(keyB);
        const match: MatchResult = {
          matchId: crypto.randomUUID(),
          gameId: a.gameId,
          matchedAt: now,
          players: [a, bestMatch],
        };

        if (a.gameId === TTT_GAME_ID) {
          await this.createTicTacToeMatch(a, bestMatch, match.matchId);
        } else {
          matches[keyA] = match;
          matches[keyB] = match;
          await this.state.storage.put("matches", matches);
          await this.notifyWebSocket(a, {
            type: "matched",
            matchId: match.matchId,
            opponent: {
              userId: bestMatch.userId,
              username: bestMatch.username,
              elo: bestMatch.elo,
            },
          });
          await this.notifyWebSocket(bestMatch, {
            type: "matched",
            matchId: match.matchId,
            opponent: { userId: a.userId, username: a.username, elo: a.elo },
          });
        }

        delete queue[keyA];
        delete queue[keyB];
        await this.state.storage.put("queue", queue);
      }
    }
  }

  private async createTicTacToeMatch(
    playerA: QueueEntry,
    playerB: QueueEntry,
    roomId: string,
  ): Promise<void> {
    const tokenX = crypto.randomUUID();
    const tokenO = crypto.randomUUID();

    const stub = this.matchmakingEnv.GAME_ROOM.get(
      this.matchmakingEnv.GAME_ROOM.idFromName(roomId),
    );

    const responseX = await stub.fetch("http://do/internal/register-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: tokenX,
        userId: Number(playerA.userId),
        username: playerA.username,
        elo: playerA.elo,
        symbol: "X",
        roomId,
      }),
    });

    if (!responseX.ok) throw new Error("Failed to register first tic-tac-toe player");
    const responseO = await stub.fetch("http://do/internal/register-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: tokenO,
        userId: Number(playerB.userId),
        username: playerB.username,
        elo: playerB.elo,
        symbol: "O",
        roomId,
      }),
    });
    if (!responseO.ok) throw new Error("Failed to register second tic-tac-toe player");

    await this.notifyWebSocket(playerA, {
      type: "matched",
      roomId,
      token: tokenX,
      symbol: "X",
      opponent: { username: playerB.username, elo: playerB.elo },
    });
    await this.notifyWebSocket(playerB, {
      type: "matched",
      roomId,
      token: tokenO,
      symbol: "O",
      opponent: { username: playerA.username, elo: playerA.elo },
    });
  }

  private async notifyWebSocket(
    player: QueueEntry,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const key = getQueueKey(player.gameId, player.userId);
    const ws = this.state.getWebSockets().find((socket) => {
      const [gameId, userId] = this.state.getTags(socket);
      return getQueueKey(gameId ?? "", userId ?? "") === key;
    });
    if (!ws) return;
    ws.send(JSON.stringify(payload));
    ws.close();
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationChain;
    let release = () => {};
    this.operationChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
