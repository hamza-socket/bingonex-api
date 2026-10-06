import { DEFAULT_ELO_MATCHING, DEFAULT_QUEUE_TTL_MS } from "../lib/constants";
import type { EloOptions, GameDefinition, MatchingConfig } from "../types/types";

type MatchingInput = { strategy: "fifo" } | ({ strategy: "elo-range" } & Partial<EloOptions>);

type GameInput = {
  matching?: MatchingInput;
  queueTtlMs?: number | null;
  onMatch: GameDefinition["onMatch"];
};

function resolveMatching(input?: MatchingInput): MatchingConfig {
  if (input?.strategy === "fifo") return { strategy: "fifo" };
  return { ...DEFAULT_ELO_MATCHING, ...input };
}

export function defineGame(input: GameInput): GameDefinition {
  return {
    matching: resolveMatching(input.matching),
    queueTtlMs: input.queueTtlMs === undefined ? DEFAULT_QUEUE_TTL_MS : input.queueTtlMs,
    onMatch: input.onMatch,
  };
}