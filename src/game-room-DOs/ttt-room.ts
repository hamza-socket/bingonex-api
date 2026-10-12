import { DurableObject } from "cloudflare:workers";
import { createSerializer } from "../lib/serial-queue";
import { drizzle } from "drizzle-orm/d1";
import { computeResult, ratingUpdates, readRatings, type GameResult } from "../lib/game-result";

type Mark = "X" | "O";
type Status = "waiting" | "active" | "finished";
type EndReason = "normal" | "disconnect" | "abandoned";

interface PlayerInfo {
  userId: string;
  username: string;
  elo: number;
  symbol: Mark;
  connected: boolean;
}

interface TokenData {
  userId: string;
  username: string;
  elo: number;
  symbol: Mark;
  expiresAt: number;
}

interface Players {
  X: PlayerInfo | null;
  O: PlayerInfo | null;
}

interface GameState {
  roomId: string;
  status: Status;
  board: (Mark | null)[];
  currentTurn: Mark;
  winner: Mark | "draw" | null;
  endReason: EndReason | null;
  createdAt: number;
  rematchVotes: Mark[];
}

interface Timers {
  disconnect: Partial<Record<Mark, number>>;
  expireAt: number | null;
  retryAt: number | null;
}

interface Seat {
  userId: string;
  username: string;
  elo: number;
}

type Seats = Partial<Record<Mark, Seat>>;

type Env = {
  game_db: D1Database;
  MATCHMAKING_ROOM: DurableObjectNamespace;
};

const MARKS: Mark[] = ["X", "O"];
const GRACE_MS = 30_000;
const TOKEN_TTL_MS = 5 * 60_000;
const ROOM_TTL_MS = 5 * 60_000;
const RETRY_MS = 15_000;

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

const other = (mark: Mark): Mark => (mark === "X" ? "O" : "X");
const isMark = (value: unknown): value is Mark => value === "X" || value === "O";
const emptyPlayers = (): Players => ({ X: null, O: null });
const emptyTimers = (): Timers => ({ disconnect: {}, expireAt: null, retryAt: null });
const toSeat = (winner: Mark | null): "a" | "b" | null =>
  winner === null ? null : winner === "X" ? "a" : "b";

export class TTTRoom extends DurableObject<Env> {
  private run = createSerializer();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/internal/register-token")) {
      return this.run(() => this.handleRegisterToken(request));
    }
    if (url.pathname.endsWith("/internal/issue-token")) {
      return this.run(() => this.handleIssueToken(request));
    }
    if (url.pathname.endsWith("/status")) {
      return this.run(() => this.handleStatus(request));
    }
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.run(() => this.handleUpgrade(request));
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.run(() => this.processAlarm());
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.run(async () => {
      const mark = this.markOf(ws);
      try {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        const data = JSON.parse(text) as { type?: string; position?: unknown };

        if (data.type === "move") {
          await this.handleMove(ws, mark, data.position);
        } else if (data.type === "rematch") {
          await this.handleRematch(ws, mark);
        } else {
          this.send(ws, { type: "error", message: "Unknown message type" });
        }
      } catch (err) {
        this.send(ws, {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.run(() => this.onSocketGone(ws));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.run(() => this.onSocketGone(ws));
  }

  private markOf(ws: WebSocket): Mark {
    return this.ctx.getTags(ws)[0] as Mark;
  }

  private getGame(): Promise<GameState | undefined> {
    return this.ctx.storage.get<GameState>("gameState");
  }

  private async getPlayers(): Promise<Players> {
    return (await this.ctx.storage.get<Players>("players")) ?? emptyPlayers();
  }

  private async getSeats(): Promise<Seats> {
    return (await this.ctx.storage.get<Seats>("seats")) ?? {};
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

  private broadcast(message: object, only?: Mark[]): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (only && !only.includes(this.markOf(ws))) continue;
      this.send(ws, message);
    }
  }

  private sanitizePlayers(players: Players) {
    const pick = (player: PlayerInfo | null) =>
      player ? { username: player.username, elo: player.elo, connected: player.connected } : null;
    return { X: pick(players.X), O: pick(players.O) };
  }

  private async handleRegisterToken(request: Request): Promise<Response> {
    const body = await request.json<Record<string, unknown>>().catch(() => null);
    if (!body) return Response.json({ error: "invalid_payload" }, { status: 400 });

    const { token, userId, username, elo, symbol, roomId } = body;
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      typeof userId !== "string" ||
      userId.length === 0 ||
      typeof username !== "string" ||
      username.length === 0 ||
      typeof elo !== "number" ||
      !Number.isFinite(elo) ||
      !isMark(symbol) ||
      typeof roomId !== "string" ||
      roomId.length === 0
    ) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }

    const now = Date.now();
    const tokens = (await this.ctx.storage.get<Record<string, TokenData>>("tokens")) ?? {};
    for (const [existing, data] of Object.entries(tokens)) {
      if (data.expiresAt <= now) delete tokens[existing];
    }
    tokens[token] = { userId, username, elo, symbol, expiresAt: now + TOKEN_TTL_MS };
    await this.ctx.storage.put("tokens", tokens);

    const seats = await this.getSeats();
    if (seats[symbol] && seats[symbol]!.userId !== userId) {
      return Response.json({ error: "seat_taken" }, { status: 409 });
    }
    seats[symbol] = { userId, username, elo };
    await this.ctx.storage.put("seats", seats);

    if (!(await this.getGame())) {
      const game: GameState = {
        roomId,
        status: "waiting",
        board: Array(9).fill(null),
        currentTurn: "X",
        winner: null,
        endReason: null,
        createdAt: now,
        rematchVotes: [],
      };
      await this.ctx.storage.put("gameState", game);
      await this.ctx.storage.put("players", emptyPlayers());
      const timers = emptyTimers();
      timers.expireAt = now + ROOM_TTL_MS;
      await this.saveTimers(timers);
    }

    return Response.json({ success: true });
  }

  private async handleStatus(request: Request): Promise<Response> {
    const gameState = await this.getGame();
    if (!gameState) return Response.json({ error: "not_found" }, { status: 404 });

    const userId = request.headers.get("x-user-id");
    const seats = await this.getSeats();
    const symbol = MARKS.find((m) => seats[m]?.userId === userId);
    if (!userId || !symbol) return Response.json({ error: "forbidden" }, { status: 403 });

    const players = await this.getPlayers();
    return Response.json({ symbol, gameState, players: this.sanitizePlayers(players) });
  }

  private async handleIssueToken(request: Request): Promise<Response> {
    const body = await request.json<Record<string, unknown>>().catch(() => null);
    const userId = body?.userId;
    if (typeof userId !== "string" || userId.length === 0) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }

    const game = await this.getGame();
    if (!game) return Response.json({ error: "not_found" }, { status: 404 });

    const seats = await this.getSeats();
    const symbol = MARKS.find((m) => seats[m]?.userId === userId);
    const seat = symbol ? seats[symbol] : undefined;
    if (!symbol || !seat) return Response.json({ error: "forbidden" }, { status: 403 });

    const now = Date.now();
    const token = crypto.randomUUID();
    const tokens = (await this.ctx.storage.get<Record<string, TokenData>>("tokens")) ?? {};
    for (const [existing, data] of Object.entries(tokens)) {
      if (data.expiresAt <= now) delete tokens[existing];
    }
    tokens[token] = {
      userId,
      username: seat.username,
      elo: seat.elo,
      symbol,
      expiresAt: now + TOKEN_TTL_MS,
    };
    await this.ctx.storage.put("tokens", tokens);

    return Response.json({ roomId: game.roomId, token, side: symbol });
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
    if (!(await this.getGame())) return new Response("Room unavailable", { status: 410 });

    const players = await this.getPlayers();
    const existing = players[data.symbol];
    if (existing && existing.userId !== data.userId) {
      return new Response("Seat taken", { status: 403 });
    }

    for (const old of this.ctx.getWebSockets(data.symbol)) {
      try {
        old.close(4000, "replaced");
      } catch {}
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [data.symbol, String(data.userId)]);

    await this.onPlayerConnect(data, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async onPlayerConnect(data: TokenData, ws: WebSocket): Promise<void> {
    const game = await this.getGame();
    if (!game) {
      ws.close(1011, "room unavailable");
      return;
    }

    const players = await this.getPlayers();
    const existing = players[data.symbol];

    players[data.symbol] = {
      userId: data.userId,
      username: data.username,
      elo: existing?.elo ?? data.elo,
      symbol: data.symbol,
      connected: true,
    };
    await this.ctx.storage.put("players", players);

    const timers = await this.getTimers();
    if (timers.disconnect[data.symbol] !== undefined) {
      delete timers.disconnect[data.symbol];
      await this.saveTimers(timers);
    }

    if (existing) {
      this.send(ws, {
        type: "reconnected",
        board: game.board,
        currentTurn: game.currentTurn,
        status: game.status,
        winner: game.winner,
        players: this.sanitizePlayers(players),
      });
      this.broadcast({ type: "opponent_reconnected" }, [other(data.symbol)]);
    }

    const started = await this.tryStart(game, players);
    if (!existing && !started) this.send(ws, { type: "waiting" });
  }

  private async tryStart(game: GameState, players: Players): Promise<boolean> {
    if (game.status !== "waiting" || !players.X?.connected || !players.O?.connected) {
      return false;
    }

    const active: GameState = { ...game, status: "active" };
    await this.ctx.storage.put("gameState", active);

    const timers = await this.getTimers();
    timers.expireAt = null;
    await this.saveTimers(timers);

    this.broadcast({
      type: "start",
      board: active.board,
      currentTurn: active.currentTurn,
      players: this.sanitizePlayers(players),
    });
    return true;
  }

  private async onSocketGone(ws: WebSocket): Promise<void> {
    const mark = this.markOf(ws);
    if (!isMark(mark)) return;

    const stillOpen = this.ctx
      .getWebSockets(mark)
      .some((socket) => socket !== ws && socket.readyState === WebSocket.OPEN);
    if (stillOpen) return;

    const game = await this.getGame();
    if (!game) return;

    const players = await this.getPlayers();
    if (players[mark]) {
      players[mark]!.connected = false;
      await this.ctx.storage.put("players", players);
    }

    if (game.status !== "active") return;

    const timers = await this.getTimers();
    timers.disconnect[mark] = Date.now() + GRACE_MS;
    await this.saveTimers(timers);

    this.broadcast({ type: "opponent_disconnected", timeoutIn: GRACE_MS / 1000 }, [other(mark)]);
  }

  private async handleMove(ws: WebSocket, mark: Mark, position: unknown): Promise<void> {
    const game = await this.getGame();

    if (!game || game.status !== "active") {
      this.send(ws, { type: "error", message: "Game is not active" });
      return;
    }
    if (game.currentTurn !== mark) {
      this.send(ws, { type: "error", message: "Not your turn" });
      return;
    }
    if (
      typeof position !== "number" ||
      !Number.isInteger(position) ||
      position < 0 ||
      position > 8 ||
      game.board[position] !== null
    ) {
      this.send(ws, { type: "error", message: "Invalid move" });
      return;
    }

    const board = [...game.board];
    board[position] = mark;

    const winner = this.checkWinner(board);
    const isDraw = !winner && board.every((cell) => cell !== null);

    if (winner || isDraw) {
      await this.finalize({ ...game, board }, winner, "normal");
      return;
    }

    const nextTurn = other(mark);
    await this.ctx.storage.put("gameState", { ...game, board, currentTurn: nextTurn });
    this.broadcast({ type: "update", board, currentTurn: nextTurn, lastMove: position });
  }

  private async handleRematch(ws: WebSocket, mark: Mark): Promise<void> {
    const game = await this.getGame();
    if (!game || game.status !== "finished" || game.endReason === "abandoned") return;

    const players = await this.getPlayers();
    if (!players.X?.connected || !players.O?.connected) {
      this.send(ws, { type: "error", message: "Opponent is not connected" });
      return;
    }

    if (!game.rematchVotes.includes(mark)) game.rematchVotes.push(mark);

    if (game.rematchVotes.length < 2) {
      await this.ctx.storage.put("gameState", game);
      this.broadcast({ type: "rematch_vote", from: mark });
      return;
    }

    const fresh = await readRatings(this.env.game_db, [players.X.userId, players.O.userId]);
    for (const m of MARKS) {
      const player = players[m]!;
      player.elo = fresh.get(player.userId) ?? player.elo;
    }
    await this.ctx.storage.put("players", players);

    const next: GameState = {
      roomId: game.roomId,
      status: "active",
      board: Array(9).fill(null),
      currentTurn: "X",
      winner: null,
      endReason: null,
      createdAt: Date.now(),
      rematchVotes: [],
    };
    await this.ctx.storage.put("gameState", next);

    const timers = await this.getTimers();
    timers.expireAt = null;
    timers.disconnect = {};
    await this.saveTimers(timers);

    this.broadcast({
      type: "start",
      board: next.board,
      currentTurn: next.currentTurn,
      players: this.sanitizePlayers(players),
    });
  }

  private async finalize(game: GameState, winner: Mark | null, reason: EndReason): Promise<void> {
    if (game.status !== "active") return;

    const players = await this.getPlayers();
    const finished: GameState = {
      ...game,
      status: "finished",
      winner: reason === "abandoned" ? null : (winner ?? "draw"),
      endReason: reason,
      rematchVotes: [],
    };
    await this.ctx.storage.put("gameState", finished);

    const timers = await this.getTimers();
    timers.disconnect = {};
    timers.expireAt = Date.now() + ROOM_TTL_MS;
    await this.saveTimers(timers);

    let eloChanges: { X: number; O: number } | null = null;

    if (reason !== "abandoned" && players.X && players.O) {
      const result = await computeResult(
        this.env.game_db,
        game.roomId,
        { userId: players.X.userId, rating: players.X.elo },
        { userId: players.O.userId, rating: players.O.elo },
        toSeat(winner),
      );
      eloChanges = { X: result.deltaA, O: result.deltaB };

      try {
        await this.persistResult(result);
      } catch (err) {
        console.error("persist failed", err);
        await this.ctx.storage.put("pendingResult", result);
        const latest = await this.getTimers();
        latest.retryAt = Date.now() + RETRY_MS;
        await this.saveTimers(latest);
      }
    }

    this.broadcast({
      type: "end",
      result: reason === "abandoned" ? "abandoned" : (winner ?? "draw"),
      winner,
      board: finished.board,
      eloChanges,
      reason,
    });

    await this.release();
  }

  private async persistResult(result: GameResult): Promise<void> {
    const db = drizzle(this.env.game_db);
    await db.batch([...ratingUpdates(db, result)]);
  }

  private async processAlarm(): Promise<void> {
    const now = Date.now();
    const game = await this.getGame();

    if (!game) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }

    const pending = await this.ctx.storage.get<GameResult>("pendingResult");
    if (pending) {
      const timers = await this.getTimers();
      if (timers.retryAt !== null && timers.retryAt <= now) {
        try {
          await this.persistResult(pending);
          await this.ctx.storage.delete("pendingResult");
          timers.retryAt = null;
        } catch {
          timers.retryAt = now + RETRY_MS;
        }
        await this.saveTimers(timers);
      }
    }

    if (game.status === "active") {
      const timers = await this.getTimers();
      const expired = MARKS.filter((m) => {
        const deadline = timers.disconnect[m];
        return deadline !== undefined && deadline <= now;
      });

      if (expired.length > 0) {
        const players = await this.getPlayers();
        const survivor = MARKS.find((m) => !expired.includes(m) && players[m]?.connected);

        if (survivor) {
          await this.finalize(game, survivor, "disconnect");
        } else {
          const horizon = Math.max(...MARKS.map((m) => timers.disconnect[m] ?? 0));
          if (horizon <= now) {
            await this.finalize(game, null, "abandoned");
          } else {
            for (const m of expired) timers.disconnect[m] = horizon;
            await this.saveTimers(timers);
          }
        }
      }
    }

    const timers = await this.getTimers();
    if (timers.expireAt !== null && timers.expireAt <= now) {
      if (await this.ctx.storage.get("pendingResult")) {
        timers.expireAt = now + RETRY_MS;
        await this.saveTimers(timers);
      } else {
        await this.release();
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

  private async release(): Promise<void> {
    const game = await this.getGame();
    if (!game) return;
    const seats = await this.getSeats();
    const stub = this.env.MATCHMAKING_ROOM.get(this.env.MATCHMAKING_ROOM.idFromName("global"));
    await Promise.all(
      MARKS.map(async (mark) => {
        const seat = seats[mark];
        if (!seat) return;
        try {
          await stub.fetch("http://do/internal/queue/ack", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gameId: "ttt", userId: seat.userId, matchId: game.roomId }),
          });
        } catch (err) {
          console.error("release failed", err);
        }
      }),
    );
  }

  private checkWinner(board: (Mark | null)[]): Mark | null {
    for (const [a, b, c] of LINES) {
      if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
    }
    return null;
  }
}