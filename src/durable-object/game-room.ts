import { DurableObject } from "cloudflare:workers";
import { countLines } from "../lib/bingo";

export type RoomState = {
  version: 1;
  gameId: string;
  status: "waiting" | "active" | "finished";
  turn: "p1" | "p2" | null;
  players: {
    p1: { id: string; card: number[] } | null;
    p2: { id: string; card: number[] } | null;
  };
  called: number[];
  p1Lines: number;
  p2Lines: number;
  result: "p1" | "p2" | "draw" | null;
  finishedAt: number | null;
  updatedAt: number;
};

export class GameRoom extends DurableObject {
  private async readState(): Promise<RoomState> {
    const existing = await this.ctx.storage.get<RoomState>("state");
    if (existing) return existing;

    const initial: RoomState = {
      version: 1,
      gameId: this.ctx.id.toString(),
      status: "waiting",
      turn: null,
      players: { p1: null, p2: null },
      called: [],
      p1Lines: 0,
      p2Lines: 0,
      result: null,
      finishedAt: null,
      updatedAt: Date.now(),
    };

    await this.ctx.storage.put("state", initial);
    return initial;
  }

  private async writeState(next: RoomState) {
    await this.ctx.storage.put("state", next);
    this.broadcast({ v: 1, t: "state", state: next });
  }

  private broadcast(payload: Record<string, unknown>) {
    const message = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {}
    }
  }

  private async handleMove(state: RoomState, payload: { playerId: string; number: number }) {
    if (state.status !== "active" || !state.turn) {
      return;
    }

    const isP1 = state.players.p1?.id === payload.playerId;
    const isP2 = state.players.p2?.id === payload.playerId;
    if (!isP1 && !isP2) {
      return;
    }

    const playerKey = isP1 ? "p1" : "p2";
    if (state.turn !== playerKey) {
      return;
    }

    if (state.called.includes(payload.number)) {
      return;
    }

    const nextCalled = [...state.called, payload.number];
    const nextSet = new Set(nextCalled);

    const nextState: RoomState = {
      ...state,
      called: nextCalled,
      p1Lines: state.players.p1 ? countLines(state.players.p1.card, nextSet) : 0,
      p2Lines: state.players.p2 ? countLines(state.players.p2.card, nextSet) : 0,
      turn: playerKey === "p1" ? "p2" : "p1",
      updatedAt: Date.now(),
    };

    if (nextState.p1Lines >= 5 || nextState.p2Lines >= 5) {
      nextState.status = "finished";
      nextState.result =
        nextState.p1Lines >= 5 && nextState.p2Lines >= 5
          ? "draw"
          : nextState.p1Lines >= 5
            ? "p1"
            : "p2";
      nextState.finishedAt = Date.now();
      nextState.turn = null;
    }

    await this.writeState(nextState);
  }

  private async handleResign(state: RoomState, playerId: string) {
    if (state.status !== "active") return;
    const winner = state.players.p1?.id === playerId ? "p2" : "p1";
    if (!winner) return;

    const nextState: RoomState = {
      ...state,
      status: "finished",
      result: winner,
      turn: null,
      finishedAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.writeState(nextState);
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "webSocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    if (url.pathname.endsWith("/state")) {
      return Response.json(await this.readState());
    }

    if (url.pathname.endsWith("/join")) {
      const state = await this.readState();
      const payload = await request.json().catch(() => null);
      if (
        !payload ||
        typeof payload !== "object" ||
        !("playerId" in payload) ||
        !("card" in payload)
      ) {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }

      const playerId = String(payload.playerId);
      const card = Array.isArray(payload.card) ? payload.card.map((n) => Number(n)) : [];
      if (!card.length || card.some((n) => !Number.isInteger(n) || n < 1 || n > 25)) {
        return Response.json({ error: "invalid_card" }, { status: 400 });
      }

      if (state.players.p1 && state.players.p1.id === playerId) {
        state.players.p1 = { id: playerId, card };
      } else if (!state.players.p1) {
        state.players.p1 = { id: playerId, card };
      } else if (state.players.p2 && state.players.p2.id === playerId) {
        state.players.p2 = { id: playerId, card };
      } else if (!state.players.p2) {
        state.players.p2 = { id: playerId, card };
      }

      if (state.players.p1 && state.players.p2 && state.status === "waiting") {
        state.status = "active";
        state.turn = "p1";
      }

      state.updatedAt = Date.now();
      await this.writeState(state);
      return Response.json(state);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;

    let payload: { type?: string; playerId?: string; number?: number } | null = null;
    try {
      payload = JSON.parse(message) as { type?: string; playerId?: string; number?: number };
    } catch {
      return;
    }

    const state = await this.readState();
    if (!payload || typeof payload !== "object") return;

    if (payload.type === "sync") {
      ws.send(JSON.stringify({ v: 1, t: "state", state }));
      return;
    }

    if (
      payload.type === "move" &&
      typeof payload.playerId === "string" &&
      typeof payload.number === "number"
    ) {
      await this.handleMove(state, { playerId: payload.playerId, number: payload.number });
      return;
    }

    if (payload.type === "resign" && typeof payload.playerId === "string") {
      await this.handleResign(state, payload.playerId);
    }
  }
}

export default GameRoom;
