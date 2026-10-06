import { bingo } from "../routes/bingo/bingo";
import { ttt } from "../routes/ttt/ttt";
import type { GameDefinition } from "./types";

export const GAMES = { ttt, bingo } satisfies Record<string, GameDefinition>;

export type GameId = keyof typeof GAMES;

export const GAME_IDS = Object.keys(GAMES) as [GameId, ...GameId[]];

export function getGame(gameId: string): GameDefinition | undefined {
  return Object.hasOwn(GAMES, gameId) ? GAMES[gameId as GameId] : undefined;
}