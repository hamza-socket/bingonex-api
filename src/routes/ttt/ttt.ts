import { defineGame } from "../../lib/define-game";
import type { QueueEntry } from "../../types/types";

type Seat = {
  token: string;
  player: QueueEntry;
  symbol: "X" | "O";
  roomId: string;
};

async function registerSeat(stub: DurableObjectStub, seat: Seat): Promise<void> {
  const response = await stub.fetch("http://do/internal/register-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: seat.token,
      userId: Number(seat.player.userId),
      username: seat.player.username,
      elo: seat.player.elo,
      symbol: seat.symbol,
      roomId: seat.roomId,
    }),
  });
  if (!response.ok) throw new Error(`Failed to register tic-tac-toe player ${seat.symbol}`);
}

export const ttt = defineGame({
  queueTtlMs: null,
  async onMatch({ env, matchId, players: [a, b] }) {
    const stub = env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(matchId));
    const tokenX = crypto.randomUUID();
    const tokenO = crypto.randomUUID();

    await Promise.all([
      registerSeat(stub, { token: tokenX, player: a, symbol: "X", roomId: matchId }),
      registerSeat(stub, { token: tokenO, player: b, symbol: "O", roomId: matchId }),
    ]);

    return [
      {
        roomId: matchId,
        token: tokenX,
        symbol: "X",
        opponent: { username: b.username, elo: b.elo },
      },
      {
        roomId: matchId,
        token: tokenO,
        symbol: "O",
        opponent: { username: a.username, elo: a.elo },
      },
    ];
  },
});