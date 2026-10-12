import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { games } from "../db/schema";
import { cardSchema, countLines, numberSchema, WIN_LINES } from "../lib/bingo";
import { computeResult, ratingUpdates, type GameResult } from "../lib/game-result";
import { createSerializer } from "../lib/serial-queue";

export type Side = "p1" | "p2";
type Status = "waiting" | "active" | "finished";
type EndReason = "lines" | "resign" | "disconnect" | "abandoned";

type Player = {
  id: string;
  username: string;
  avatarUrl: string | null;
  rating: number;
  connected: boolean;
};

type Cards = Partial<Record<Side, number[]>>;

export type RoomState = {
  version: 1;
  gameId: string;
  status: Status;
  turn: Side | null;
  players: Record<Side, Player | null>;
  called: number[];
  p1Lines: number;
  p2Lines: number;
  result: Side | "draw" | "abandoned" | null;
  endReason: EndReason | null;
  ratingChanges: Record<Side, number> | null;
  finishedAt: number | null;
  updatedAt: number;
};

type TokenData = {
  userId: string;
  side: Side;
  expiresAt: number;
};

type Timers = {
  disconnect: Partial<Record<Side, number>>;
  expireAt: number | null;
  retryAt: number | null;
};

type PendingGame = {
  result: GameResult;
  called: number[];
  p1Card: number[];
  p2Card: number[];
  p1Lines: number;
  p2Lines: number;
  finishedAt: number;
};

type Env = {
  game_db: D1Database;
  MATCHMAKING_ROOM: DurableObjectNamespace;
};

const SIDES: Side[] = ["p1", "p2"];
const CARD_SIZE = 25;
const GRACE_MS = 30_000;
const TOKEN_TTL_MS = 5 * 60_000;
const ROOM_TTL_MS = 5 * 60_000;
const RETRY_MS = 15_000;

const other = (side: Side): Side => (side === "p1" ? "p2" : "p1");
const isSide = (value: unknown): value is Side => value === "p1" || value === "p2";
const emptyTimers = (): Timers => ({ disconnect: {}, expireAt: null, retryAt: null });
const toSeat = (result: Side | "draw"): "a" | "b" | null =>
  result === "draw" ? null : result === "p1" ? "a" : "b";

function randomInt(max: number): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] % max;
}

function createCard(): number[] {
  const card = Array.from({ length: CARD_SIZE }, (_, index) => index + 1);
  for (let i = card.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [card[i], card[j]] = [card[j], card[i]];
  }
  return card;
}

export class GameRoom extends DurableObject<Env> {
  private run = createSerializer();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/internal/register-token")) {
      return this.run(() => this.handleRegisterToken(request));
    }
    if (url.pathname.endsWith("/internal/issue-token")) {
      return this.run(() => this.handleIssueToken(request));
    }
    if (url.pathname.endsWith("/state")) {
      return this.run(() => this.handleState(request));
    }
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.run(() => this.handleUpgrade(request));
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.run(() => this.processAlarm());
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.run(async () => {
      const side = this.sideOf(ws);
      if (!isSide(side)) return;

      let payload: { type?: string; number?: unknown } | null = null;
      try {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        payload = JSON.parse(text) as { type?: string; number?: unknown };
      } catch {
        this.send(ws, { v: 1, t: "error", message: "Malformed message" });
        return;
      }
      if (!payload || typeof payload !== "object") return;

      if (payload.type === "sync") {
        const state = await this.getState();
        if (state) {
          this.send(ws, { v: 1, t: "state", state: this.view(state, await this.getCards(), side) });
        }
      } else if (payload.type === "move") {
        await this.handleMove(ws, side, payload.number);
      } else if (payload.type === "resign") {
        const state = await this.getState();
        if (state) await this.finalize(state, other(side), "resign");
      } else {
        this.send(ws, { v: 1, t: "error", message: "Unknown message type" });
      }
    });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.run(() => this.onSocketGone(ws));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.run(() => this.onSocketGone(ws));
  }

  private sideOf(ws: WebSocket): Side {
    return this.ctx.getTags(ws)[0] as Side;
  }

  private sideFor(state: RoomState, userId: string | null): Side | null {
    if (!userId) return null;
    return SIDES.find((side) => state.players[side]?.id === userId) ?? null;
  }

  private getState(): Promise<RoomState | undefined> {
    return this.ctx.storage.get<RoomState>("state");
  }

  private async getCards(): Promise<Cards> {
    return (await this.ctx.storage.get<Cards>("cards")) ?? {};
  }

  private async getTimers(): Promise<Timers> {
    return (await this.ctx.storage.get<Timers>("timers")) ?? emptyTimers();
  }

  private async saveTimers(timers: Timers): Promise<void> {
    await this.ctx.storage.put("timers", timers);
    const times = [...Object.values(timers.disconnect), timers.expireAt, timers.retryAt].filter(
      (value): value is number => typeof value === "number",
    );
    if (times.length > 0) {
      await this.ctx.storage.setAlarm(Math.min(...times));
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private send(ws: WebSocket, message: object): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {}
  }

  private broadcastRaw(message: object, only?: Side): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (only && this.sideOf(ws) !== only) continue;
      this.send(ws, message);
    }
  }

  private view(state: RoomState, cards: Cards, side: Side) {
    const opponentSide = other(side);
    const opponent = state.players[opponentSide];
    const finished = state.status === "finished";
    const outcome =
      !finished || state.result === null
        ? null
        : state.result === "draw" || state.result === "abandoned"
          ? state.result
          : state.result === side
            ? "win"
            : "loss";

    return {
      id: state.gameId,
      side,
      status: state.status,
      outcome,
      endReason: state.endReason,
      yourTurn: state.status === "active" && state.turn === side,
      card: cards[side] ?? null,
      called: state.called,
      lastCalled: state.called.at(-1) ?? null,
      yourLines: side === "p1" ? state.p1Lines : state.p2Lines,
      opponentLines: side === "p1" ? state.p2Lines : state.p1Lines,
      opponent: opponent
        ? {
            id: opponent.id,
            name: opponent.username,
            avatarUrl: opponent.avatarUrl,
            connected: opponent.connected,
          }
        : null,
      opponentCard: finished ? (cards[opponentSide] ?? null) : null,
      moveCount: state.called.length,
      ratingChange: state.ratingChanges?.[side] ?? null,
    };
  }

  private async pushState(state: RoomState): Promise<void> {
    const cards = await this.getCards();
    for (const ws of this.ctx.getWebSockets()) {
      const side = this.sideOf(ws);
      if (!isSide(side)) continue;
      this.send(ws, { v: 1, t: "state", state: this.view(state, cards, side) });
    }
  }

  private async writeState(state: RoomState): Promise<void> {
    await this.ctx.storage.put("state", state);
    await this.pushState(state);
  }

  private async handleRegisterToken(request: Request): Promise<Response> {
    const body = await request.json<Record<string, unknown>>().catch(() => null);
    if (!body) return Response.json({ error: "invalid_payload" }, { status: 400 });

    const { token, userId, username, elo, side, roomId, metadata } = body;
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      typeof userId !== "string" ||
      userId.length === 0 ||
      typeof username !== "string" ||
      username.length === 0 ||
      typeof elo !== "number" ||
      !Number.isFinite(elo) ||
      !isSide(side) ||
      typeof roomId !== "string" ||
      roomId.length === 0
    ) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }

    const meta =
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {};
    const avatarUrl = typeof meta.avatarUrl === "string" ? meta.avatarUrl : null;
    const now = Date.now();

    let state = await this.getState();
    if (!state) {
      state = {
        version: 1,
        gameId: roomId,
        status: "waiting",
        turn: null,
        players: { p1: null, p2: null },
        called: [],
        p1Lines: 0,
        p2Lines: 0,
        result: null,
        endReason: null,
        ratingChanges: null,
        finishedAt: null,
        updatedAt: now,
      };
      const timers = emptyTimers();
      timers.expireAt = now + ROOM_TTL_MS;
      await this.saveTimers(timers);
    }

    const seat = state.players[side];
    if (seat && seat.id !== userId) {
      return Response.json({ error: "seat_taken" }, { status: 409 });
    }
    state.players[side] = {
      id: userId,
      username,
      avatarUrl,
      rating: elo,
      connected: seat?.connected ?? false,
    };
    state.updatedAt = now;
    await this.ctx.storage.put("state", state);

    const tokens = (await this.ctx.storage.get<Record<string, TokenData>>("tokens")) ?? {};
    for (const [existing, data] of Object.entries(tokens)) {
      if (data.expiresAt <= now) delete tokens[existing];
    }
    tokens[token] = { userId, side, expiresAt: now + TOKEN_TTL_MS };
    await this.ctx.storage.put("tokens", tokens);

    const cards = await this.getCards();
    if (!cards[side]) {
      const parsed = cardSchema.safeParse(meta.card);
      cards[side] = parsed.success ? parsed.data : createCard();
      await this.ctx.storage.put("cards", cards);
    }

    return Response.json({ success: true });
  }

  private async handleIssueToken(request: Request): Promise<Response> {
    const body = await request.json<Record<string, unknown>>().catch(() => null);
    const userId = body?.userId;
    if (typeof userId !== "string" || userId.length === 0) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }

    const state = await this.getState();
    if (!state) return Response.json({ error: "not_found" }, { status: 404 });

    const side = this.sideFor(state, userId);
    if (!side) return Response.json({ error: "forbidden" }, { status: 403 });

    const now = Date.now();
    const token = crypto.randomUUID();
    const tokens = (await this.ctx.storage.get<Record<string, TokenData>>("tokens")) ?? {};
    for (const [existing, data] of Object.entries(tokens)) {
      if (data.expiresAt <= now) delete tokens[existing];
    }
    tokens[token] = { userId, side, expiresAt: now + TOKEN_TTL_MS };
    await this.ctx.storage.put("tokens", tokens);

    return Response.json({ roomId: state.gameId, token, side });
  }

  private async handleState(request: Request): Promise<Response> {
    const state = await this.getState();
    if (!state) return Response.json({ error: "not_found" }, { status: 404 });

    const side = this.sideFor(state, request.headers.get("x-user-id"));
    if (!side) return Response.json({ error: "forbidden" }, { status: 403 });

    return Response.json(this.view(state, await this.getCards(), side));
  }

  private async handleUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    if (!token) return new Response("Missing token", { status: 401 });

    const tokens = (await this.ctx.storage.get<Record<string, TokenData>>("tokens")) ?? {};
    const data = tokens[token];
    if (!data) return new Response("Invalid token", { status: 401 });

    delete tokens[token];
    await this.ctx.storage.put("tokens", tokens);

    if (Date.now() > data.expiresAt) return new Response("Token expired", { status: 401 });
    if (request.headers.get("x-user-id") !== data.userId) {
      return new Response("Forbidden", { status: 403 });
    }

    const state = await this.getState();
    if (!state) return new Response("Room unavailable", { status: 410 });
    if (state.players[data.side]?.id !== data.userId) {
      return new Response("Forbidden", { status: 403 });
    }

    for (const old of this.ctx.getWebSockets(data.side)) {
      try {
        old.close(4000, "replaced");
      } catch {}
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [data.side, data.userId]);

    await this.onConnect(data);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async onConnect(data: TokenData): Promise<void> {
    const state = await this.getState();
    const player = state?.players[data.side];
    if (!state || !player) return;

    player.connected = true;

    const timers = await this.getTimers();
    const hadDeadline = timers.disconnect[data.side] !== undefined;
    if (hadDeadline) {
      delete timers.disconnect[data.side];
      await this.saveTimers(timers);
    }

    if (state.status === "waiting" && state.players.p1?.connected && state.players.p2?.connected) {
      state.status = "active";
      state.turn = "p1";
      const latest = await this.getTimers();
      latest.expireAt = null;
      await this.saveTimers(latest);
    }

    state.updatedAt = Date.now();
    await this.writeState(state);

    if (hadDeadline) this.broadcastRaw({ v: 1, t: "opponent_reconnected" }, other(data.side));
  }

  private async onSocketGone(ws: WebSocket): Promise<void> {
    const side = this.sideOf(ws);
    if (!isSide(side)) return;

    const stillOpen = this.ctx
      .getWebSockets(side)
      .some((socket) => socket !== ws && socket.readyState === WebSocket.OPEN);
    if (stillOpen) return;

    const state = await this.getState();
    if (!state) return;

    const player = state.players[side];
    if (player) player.connected = false;
    state.updatedAt = Date.now();
    await this.writeState(state);

    if (state.status !== "active") return;

    const timers = await this.getTimers();
    timers.disconnect[side] = Date.now() + GRACE_MS;
    await this.saveTimers(timers);

    this.broadcastRaw({ v: 1, t: "opponent_disconnected", timeoutIn: GRACE_MS / 1000 }, other(side));
  }

  private async handleMove(ws: WebSocket, side: Side, input: unknown): Promise<void> {
    const state = await this.getState();
    const fail = (message: string) => this.send(ws, { v: 1, t: "error", message });

    if (!state || state.status !== "active" || !state.turn) return fail("Game is not active");
    if (state.turn !== side) return fail("Not your turn");

    const parsed = numberSchema.safeParse(input);
    if (!parsed.success) return fail("Invalid number");
    const value = parsed.data;
    if (state.called.includes(value)) return fail("Number already called");

    const cards = await this.getCards();
    if (!cards.p1 || !cards.p2) return fail("Cards are not ready");

    const called = [...state.called, value];
    const calledSet = new Set(called);
    const p1Lines = countLines(cards.p1, calledSet);
    const p2Lines = countLines(cards.p2, calledSet);

    const next: RoomState = {
      ...state,
      called,
      p1Lines,
      p2Lines,
      turn: other(side),
      updatedAt: Date.now(),
    };

    if (p1Lines >= WIN_LINES || p2Lines >= WIN_LINES) {
      const result =
        p1Lines >= WIN_LINES && p2Lines >= WIN_LINES ? "draw" : p1Lines >= WIN_LINES ? "p1" : "p2";
      await this.finalize(next, result, "lines");
      return;
    }

    await this.writeState(next);
  }

  private async finalize(
    state: RoomState,
    result: Side | "draw" | "abandoned",
    reason: EndReason,
  ): Promise<void> {
    if (state.status !== "active") return;

    const now = Date.now();
    const cards = await this.getCards();
    let pending: PendingGame | null = null;
    let ratingChanges: Record<Side, number> | null = null;

    if (result !== "abandoned" && state.players.p1 && state.players.p2 && cards.p1 && cards.p2) {
      const gameResult = await computeResult(
        this.env.game_db,
        state.gameId,
        { userId: state.players.p1.id, rating: state.players.p1.rating },
        { userId: state.players.p2.id, rating: state.players.p2.rating },
        toSeat(result),
      );
      ratingChanges = { p1: gameResult.deltaA, p2: gameResult.deltaB };
      pending = {
        result: gameResult,
        called: state.called,
        p1Card: cards.p1,
        p2Card: cards.p2,
        p1Lines: state.p1Lines,
        p2Lines: state.p2Lines,
        finishedAt: now,
      };
    }

    const finished: RoomState = {
      ...state,
      status: "finished",
      turn: null,
      result,
      endReason: reason,
      ratingChanges,
      finishedAt: now,
      updatedAt: now,
    };
    await this.writeState(finished);

    const timers = await this.getTimers();
    timers.disconnect = {};
    timers.expireAt = now + ROOM_TTL_MS;
    await this.saveTimers(timers);

    if (pending) {
      try {
        await this.persistGame(pending);
      } catch (err) {
        console.error("persist failed", err);
        await this.ctx.storage.put("pendingGame", pending);
        const latest = await this.getTimers();
        latest.retryAt = Date.now() + RETRY_MS;
        await this.saveTimers(latest);
      }
    }

    await this.release(finished);
  }

  private async persistGame(pending: PendingGame): Promise<void> {
    const db = drizzle(this.env.game_db);
    const { result } = pending;
    const outcome = result.winner === "a" ? "p1" : result.winner === "b" ? "p2" : "draw";

    await db.batch([
      ...ratingUpdates(db, result),
      db
        .insert(games)
        .values({
          id: result.roomId,
          p1Id: result.aId,
          p2Id: result.bId,
          p1Card: pending.p1Card,
          p2Card: pending.p2Card,
          called: pending.called,
          p1Lines: pending.p1Lines,
          p2Lines: pending.p2Lines,
          turn: pending.called.length % 2 === 0 ? "p1" : "p2",
          moveCount: pending.called.length,
          status: "finished",
          result: outcome,
          finishedAt: new Date(pending.finishedAt),
        })
        .onConflictDoNothing(),
    ]);
  }

  private async release(state: RoomState): Promise<void> {
    const stub = this.env.MATCHMAKING_ROOM.get(this.env.MATCHMAKING_ROOM.idFromName("global"));
    await Promise.all(
      SIDES.map(async (side) => {
        const player = state.players[side];
        if (!player) return;
        try {
          await stub.fetch("http://do/internal/queue/ack", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gameId: "bingo", userId: player.id, matchId: state.gameId }),
          });
        } catch (err) {
          console.error("release failed", err);
        }
      }),
    );
  }

  private async processAlarm(): Promise<void> {
    const now = Date.now();
    const state = await this.getState();

    if (!state) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }

    const pending = await this.ctx.storage.get<PendingGame>("pendingGame");
    if (pending) {
      const timers = await this.getTimers();
      if (timers.retryAt !== null && timers.retryAt <= now) {
        try {
          await this.persistGame(pending);
          await this.ctx.storage.delete("pendingGame");
          timers.retryAt = null;
        } catch {
          timers.retryAt = now + RETRY_MS;
        }
        await this.saveTimers(timers);
      }
    }

    if (state.status === "active") {
      const timers = await this.getTimers();
      const expired = SIDES.filter((side) => {
        const deadline = timers.disconnect[side];
        return deadline !== undefined && deadline <= now;
      });

      if (expired.length > 0) {
        const survivor = SIDES.find(
          (side) => !expired.includes(side) && state.players[side]?.connected,
        );

        if (survivor) {
          await this.finalize(state, survivor, "disconnect");
        } else {
          const horizon = Math.max(...SIDES.map((side) => timers.disconnect[side] ?? 0));
          if (horizon <= now) {
            await this.finalize(state, "abandoned", "abandoned");
          } else {
            for (const side of expired) timers.disconnect[side] = horizon;
            await this.saveTimers(timers);
          }
        }
      }
    }

    const timers = await this.getTimers();
    if (timers.expireAt !== null && timers.expireAt <= now) {
      if (await this.ctx.storage.get("pendingGame")) {
        timers.expireAt = now + RETRY_MS;
        await this.saveTimers(timers);
      } else {
        await this.release(state);
        for (const ws of this.ctx.getWebSockets()) {
          try {
            ws.close(1000, "room expired");
          } catch {}
        }
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        return;
      }
    }

    await this.saveTimers(await this.getTimers());
  }
}

export default GameRoom;