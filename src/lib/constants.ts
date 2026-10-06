import type { EloOptions } from "../types/types";

export const RETRY_INTERVAL_MS = 5_000;
export const TOKEN_TTL_MS = 60_000;
export const MATCH_RESULT_TTL_MS = 10 * 60_000;
export const DEFAULT_QUEUE_TTL_MS = 5 * 60_000;

export const DEFAULT_ELO_MATCHING: { strategy: "elo-range" } & EloOptions = {
  strategy: "elo-range",
  baseRange: 100,
  step: 50,
  stepIntervalMs: 10_000,
  maxRange: 400,
  fallbackMs: 90_000,
};