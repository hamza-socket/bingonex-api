import { defineGame } from "../../lib/define-game";

export const bingo = defineGame({
  async onMatch({ players: [a, b] }) {
    return [
      { opponent: { userId: b.userId, username: b.username, elo: b.elo } },
      { opponent: { userId: a.userId, username: a.username, elo: a.elo } },
    ];
  },
});