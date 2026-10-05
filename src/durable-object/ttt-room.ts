import { DurableObject } from "cloudflare:workers";
import { calculateMatchElo, calculateDrawElo } from "../lib/elo-cal";

type Symbol = "X" | "O";
type Status = "waiting" | "active" | "finished";
type AlarmType = "disconnect" | "expire";

interface PlayerInfo {
  userId: number;
  username: string;
  elo: number;
  symbol: Symbol;
  connected: boolean;
}

interface TokenData {
  userId: number;
  username: string;
  elo: number;
  symbol: Symbol;
  expiresAt: number;
}

interface Players {
  X: PlayerInfo | null;
  O: PlayerInfo | null;
}

interface GameState {
  roomId: string;
  status: Status;
  board: (Symbol | null)[];
  currentTurn: Symbol;
  winner: Symbol | "draw" | null;
  createdAt: number;
  rematchVotes: Symbol[];
}

type Bindings = {
  game_db: D1Database;
};

type DurableObjectStateWithAlarm = DurableObjectState & {
  setAlarm(alarm: number): Promise<void>;
};

export class TTTRoom extends DurableObject {
  private roomEnv: Bindings;

  constructor(
    private state: DurableObjectStateWithAlarm,
    env: Bindings,
  ) {
    super(state, env);
    this.roomEnv = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    console.log("DO received:", url.pathname, request.headers.get("Upgrade"));

    if (url.pathname.endsWith("/internal/register-token")) {
      return this.handleRegisterToken(request);
    }

    if (url.pathname.endsWith("/status")) {
      return this.handleStatus();
    }

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const alarmType = await this.state.storage.get<AlarmType>("alarmType");

    if (alarmType === "disconnect") {
      await this.handleDisconnectTimeout();
    } else if (alarmType === "expire") {
      await this.state.storage.deleteAll();
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.state.getTags(ws);
    const symbol = tags[0] as Symbol;

    try {
      const data = JSON.parse(String(message));

      if (data.type === "move") {
        await this.handleMove(ws, symbol, data.position);
      } else if (data.type === "rematch") {
        await this.handleRematch(symbol);
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
    await this.handlePlayerDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handlePlayerDisconnect(ws);
  }

  private async handleRegisterToken(request: Request): Promise<Response> {
    const body = await request.json<{
      token: string;
      userId: number;
      username: string;
      elo: number;
      symbol: Symbol;
      roomId: string;
    }>();

    const tokens = (await this.state.storage.get<Record<string, TokenData>>("tokens")) ?? {};
    tokens[body.token] = {
      userId: body.userId,
      username: body.username,
      elo: body.elo,
      symbol: body.symbol,
      expiresAt: Date.now() + 5 * 60 * 1000,
    };
    await this.state.storage.put("tokens", tokens);

    const existing = await this.state.storage.get<GameState>("gameState");
    if (!existing) {
      await this.state.storage.put<GameState>("gameState", {
        roomId: body.roomId,
        status: "waiting",
        board: Array(9).fill(null),
        currentTurn: "X",
        winner: null,
        createdAt: Date.now(),
        rematchVotes: [],
      });
      await this.state.storage.put<Players>("players", { X: null, O: null });
    }

    return Response.json({ success: true });
  }

  private async handleStatus(): Promise<Response> {
    const gameState = await this.state.storage.get<GameState>("gameState");
    const players = await this.state.storage.get<Players>("players");
    return Response.json({ gameState, players });
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

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server, [
      tokenData.symbol,
      String(tokenData.userId),
      tokenData.username,
      String(tokenData.elo),
    ]);

    await this.onPlayerConnect(tokenData);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async onPlayerConnect(tokenData: TokenData): Promise<void> {
    const players = (await this.state.storage.get<Players>("players")) ?? { X: null, O: null };
    const gameState = await this.state.storage.get<GameState>("gameState");

    const existing = players[tokenData.symbol];

    if (existing && !existing.connected) {
      players[tokenData.symbol]!.connected = true;
      await this.state.storage.put("players", players);
      await this.state.storage.delete("alarmType");
      await this.state.storage.delete("disconnectedSymbol");

      const ws = this.getWebSocketBySymbol(tokenData.symbol);
      ws?.send(
        JSON.stringify({
          type: "reconnected",
          board: gameState?.board,
          currentTurn: gameState?.currentTurn,
          status: gameState?.status,
          players: this.sanitizePlayers(players),
        }),
      );
      return;
    }

    players[tokenData.symbol] = {
      userId: tokenData.userId,
      username: tokenData.username,
      elo: tokenData.elo,
      symbol: tokenData.symbol,
      connected: true,
    };

    await this.state.storage.put("players", players);

    if (players.X && players.O) {
      const updatedState: GameState = { ...gameState!, status: "active" };
      await this.state.storage.put("gameState", updatedState);

      this.broadcast({
        type: "start",
        board: updatedState.board,
        currentTurn: updatedState.currentTurn,
        players: this.sanitizePlayers(players),
      });
    } else {
      const ws = this.getWebSocketBySymbol(tokenData.symbol);
      ws?.send(JSON.stringify({ type: "waiting" }));
    }
  }

  private async handlePlayerDisconnect(ws: WebSocket): Promise<void> {
    const tags = this.state.getTags(ws);
    const symbol = tags[0] as Symbol;

    const players = (await this.state.storage.get<Players>("players")) ?? { X: null, O: null };
    const gameState = await this.state.storage.get<GameState>("gameState");

    if (players[symbol]) {
      players[symbol]!.connected = false;
      await this.state.storage.put("players", players);
    }

    if (gameState?.status !== "active") return;

    await this.state.storage.put<AlarmType>("alarmType", "disconnect");
    await this.state.storage.put<Symbol>("disconnectedSymbol", symbol);
    await this.state.setAlarm(Date.now() + 30 * 1000);

    const opponentSymbol: Symbol = symbol === "X" ? "O" : "X";
    this.broadcast({ type: "opponent_disconnected", timeoutIn: 30 }, [opponentSymbol]);
  }

  private async handleDisconnectTimeout(): Promise<void> {
    const disconnectedSymbol = await this.state.storage.get<Symbol>("disconnectedSymbol");
    const players = (await this.state.storage.get<Players>("players")) ?? { X: null, O: null };

    if (!disconnectedSymbol) return;

    const player = players[disconnectedSymbol];
    if (player?.connected) return;

    const winnerSymbol: Symbol = disconnectedSymbol === "X" ? "O" : "X";
    await this.endGame(winnerSymbol, "disconnect");
  }

  private async handleMove(ws: WebSocket, symbol: Symbol, position: number): Promise<void> {
    const gameState = await this.state.storage.get<GameState>("gameState");

    if (!gameState || gameState.status !== "active") {
      ws.send(JSON.stringify({ type: "error", message: "Game is not active" }));
      return;
    }

    if (gameState.currentTurn !== symbol) {
      ws.send(JSON.stringify({ type: "error", message: "Not your turn" }));
      return;
    }

    if (position < 0 || position > 8 || gameState.board[position] !== null) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid move" }));
      return;
    }

    const board = [...gameState.board];
    board[position] = symbol;

    const winner = this.checkWinner(board);
    const isDraw = !winner && board.every((cell) => cell !== null);

    if (winner || isDraw) {
      const updatedState = { ...gameState, board, winner: isDraw ? ("draw" as const) : winner };
      await this.state.storage.put("gameState", updatedState);
      await this.endGame(isDraw ? null : winner, "normal");
      return;
    }

    const nextTurn: Symbol = symbol === "X" ? "O" : "X";
    await this.state.storage.put("gameState", { ...gameState, board, currentTurn: nextTurn });
    this.broadcast({ type: "update", board, currentTurn: nextTurn, lastMove: position });
  }

  private async handleRematch(symbol: Symbol): Promise<void> {
    const gameState = await this.state.storage.get<GameState>("gameState");
    if (!gameState || gameState.status !== "finished") return;

    if (!gameState.rematchVotes.includes(symbol)) {
      gameState.rematchVotes.push(symbol);
    }

    if (gameState.rematchVotes.length === 2) {
      const players = (await this.state.storage.get<Players>("players")) ?? { X: null, O: null };

      const freshState: GameState = {
        roomId: gameState.roomId,
        status: "active",
        board: Array(9).fill(null),
        currentTurn: "X",
        winner: null,
        createdAt: Date.now(),
        rematchVotes: [],
      };

      await this.state.storage.put("gameState", freshState);

      this.broadcast({
        type: "start",
        board: freshState.board,
        currentTurn: freshState.currentTurn,
        players: this.sanitizePlayers(players),
      });
    } else {
      await this.state.storage.put("gameState", gameState);
      this.broadcast({ type: "rematch_vote", from: symbol });
    }
  }

  private async endGame(
    winnerSymbol: Symbol | null,
    reason: "normal" | "disconnect",
  ): Promise<void> {
    const gameState = await this.state.storage.get<GameState>("gameState");
    const players = (await this.state.storage.get<Players>("players")) ?? { X: null, O: null };

    if (!gameState || !players.X || !players.O) return;

    const finishedState: GameState = {
      ...gameState,
      status: "finished",
      winner: winnerSymbol ?? "draw",
    };
    await this.state.storage.put("gameState", finishedState);

    let eloChanges: { X: number; O: number };

    if (winnerSymbol === null) {
      const { playerA, playerB } = calculateDrawElo(players.X.elo, players.O.elo);
      eloChanges = { X: playerA.change, O: playerB.change };
      await this.persistDraw(
        players.X,
        players.O,
        playerA.newElo,
        playerB.newElo,
        gameState.roomId,
      );
    } else {
      const loserSymbol: Symbol = winnerSymbol === "X" ? "O" : "X";
      const winnerPlayer = players[winnerSymbol]!;
      const loserPlayer = players[loserSymbol]!;
      const { winner, loser } = calculateMatchElo(winnerPlayer.elo, loserPlayer.elo);

      eloChanges = {
        [winnerSymbol]: winner.change,
        [loserSymbol]: loser.change,
      } as { X: number; O: number };

      await this.persistWin(
        winnerPlayer,
        loserPlayer,
        winner.newElo,
        loser.newElo,
        winnerSymbol,
        gameState.roomId,
      );
    }

    this.broadcast({
      type: "end",
      result: winnerSymbol ?? "draw",
      winner: winnerSymbol,
      board: finishedState.board,
      eloChanges,
      reason,
    });

    await this.state.storage.put<AlarmType>("alarmType", "expire");
    await this.state.setAlarm(Date.now() + 5 * 60 * 1000);
  }

  private async persistWin(
    winner: PlayerInfo,
    loser: PlayerInfo,
    newWinnerElo: number,
    newLoserElo: number,
    winnerSymbol: Symbol,
    roomId: string,
  ): Promise<void> {
    const loserSymbol: Symbol = winnerSymbol === "X" ? "O" : "X";

    const playerXId = winnerSymbol === "X" ? winner.userId : loser.userId;
    const playerOId = winnerSymbol === "O" ? winner.userId : loser.userId;
    const eloChangeX = winnerSymbol === "X" ? newWinnerElo - winner.elo : newLoserElo - loser.elo;
    const eloChangeO = winnerSymbol === "O" ? newWinnerElo - winner.elo : newLoserElo - loser.elo;

    await this.roomEnv.game_db.batch([
      this.roomEnv.game_db
        .prepare(
          "UPDATE users SET elo=?, TTT_win=TTT_win+1, TTT_games=TTT_games+1, wins=wins+1, games=games+1 WHERE id=?",
        )
        .bind(newWinnerElo, winner.userId),

      this.roomEnv.game_db
        .prepare(
          "UPDATE users SET elo=?, TTT_lost=TTT_lost+1, TTT_games=TTT_games+1, lost=lost+1, games=games+1 WHERE id=?",
        )
        .bind(newLoserElo, loser.userId),

      this.roomEnv.game_db
        .prepare(
          "INSERT INTO ttt_games (id, room_id, player_x_id, player_o_id, winner_id, result, elo_change_x, elo_change_o) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(
          null,
          roomId,
          playerXId,
          playerOId,
          winner.userId,
          winnerSymbol,
          eloChangeX,
          eloChangeO,
        ),
    ]);
  }

  private async persistDraw(
    playerX: PlayerInfo,
    playerO: PlayerInfo,
    newXElo: number,
    newOElo: number,
    roomId: string,
  ): Promise<void> {
    await this.roomEnv.game_db.batch([
      this.roomEnv.game_db
        .prepare(
          "UPDATE users SET elo=?, TTT_draws=TTT_draws+1, TTT_games=TTT_games+1, draws=draws+1, games=games+1 WHERE id=?",
        )
        .bind(newXElo, playerX.userId),

      this.roomEnv.game_db
        .prepare(
          "UPDATE users SET elo=?, TTT_draws=TTT_draws+1, TTT_games=TTT_games+1, draws=draws+1, games=games+1 WHERE id=?",
        )
        .bind(newOElo, playerO.userId),

      this.roomEnv.game_db
        .prepare(
          "INSERT INTO ttt_games (id, room_id, player_x_id, player_o_id, winner_id, result, elo_change_x, elo_change_o) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(
          null,
          roomId,
          playerX.userId,
          playerO.userId,
          null,
          "draw",
          newXElo - playerX.elo,
          newOElo - playerO.elo,
        ),
    ]);
  }

  private checkWinner(board: (Symbol | null)[]): Symbol | null {
    const lines = [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [0, 3, 6],
      [1, 4, 7],
      [2, 5, 8],
      [0, 4, 8],
      [2, 4, 6],
    ];

    for (const [a, b, c] of lines) {
      if (board[a] && board[a] === board[b] && board[a] === board[c]) {
        return board[a] as Symbol;
      }
    }

    return null;
  }

  private getWebSocketBySymbol(symbol: Symbol): WebSocket | undefined {
    return this.state.getWebSockets().find((ws) => this.state.getTags(ws)[0] === symbol);
  }

  private sanitizePlayers(players: Players) {
    return {
      X: players.X ? { username: players.X.username, elo: players.X.elo } : null,
      O: players.O ? { username: players.O.username, elo: players.O.elo } : null,
    };
  }

  private broadcast(message: object, only?: Symbol[]): void {
    for (const ws of this.state.getWebSockets()) {
      const symbol = this.state.getTags(ws)[0] as Symbol;
      if (only && !only.includes(symbol)) continue;
      try {
        ws.send(JSON.stringify(message));
      } catch {}
    }
  }
}
