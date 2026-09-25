import { z } from "zod";

/** All 12 winning lines on a 5x5 card, as indexes into a 25-item array. */
export const LINES: number[][] = new Array(12);
for (let i = 0; i < 5; i++) {
  const offset = i * 5;
  const row = new Array<number>(5);
  const column = new Array<number>(5);

  for (let j = 0; j < 5; j++) {
    row[j] = offset + j;
    column[j] = j * 5 + i;
  }

  LINES[i * 2] = row;
  LINES[i * 2 + 1] = column;
}

LINES[10] = [0, 6, 12, 18, 24]; // diagonal
LINES[11] = [4, 8, 12, 16, 20]; // anti-diagonal

export const WIN_LINES = 5;

export function countLines(card: number[], called: Set<number>): number {
  return LINES.filter((line) => line.every((i) => called.has(card[i]))).length;
}

/** A card must be a permutation of 1..25 */
export const cardSchema = z
  .array(z.number().int().min(1).max(25))
  .length(25)
  .refine(
    (a) => new Set(a).size === 25,
    "Card must contain each of 1..25 exactly once",
  );

export const numberSchema = z.number().int().min(1).max(25);
