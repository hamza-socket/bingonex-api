import type { EloOptions, MatchingConfig, Pair, QueueEntry } from "../types/types";

export function allowedRange(options: EloOptions, waitMs: number): number {
  if (waitMs >= options.fallbackMs) return Infinity;
  const steps = Math.floor(waitMs / options.stepIntervalMs);
  return Math.min(options.baseRange + steps * options.step, options.maxRange);
}

function pairFifo(entries: readonly QueueEntry[]): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < entries.length; i += 2) {
    pairs.push([entries[i], entries[i + 1]]);
  }
  return pairs;
}

function pairByElo(entries: readonly QueueEntry[], options: EloOptions, now: number): Pair[] {
  const used = new Set<number>();
  const pairs: Pair[] = [];

  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const a = entries[i];
    const rangeA = allowedRange(options, now - a.joinedAt);
    let bestIndex = -1;
    let bestDiff = Infinity;

    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      const b = entries[j];
      const limit = Math.max(rangeA, allowedRange(options, now - b.joinedAt));
      const diff = Math.abs(a.elo - b.elo);
      if (diff <= limit && diff < bestDiff) {
        bestIndex = j;
        bestDiff = diff;
      }
    }

    if (bestIndex !== -1) {
      used.add(i);
      used.add(bestIndex);
      pairs.push([a, entries[bestIndex]]);
    }
  }

  return pairs;
}

export function findPairs(
  entries: readonly QueueEntry[],
  config: MatchingConfig,
  now: number,
): Pair[] {
  const ordered = [...entries].sort((a, b) => a.joinedAt - b.joinedAt);
  return config.strategy === "fifo" ? pairFifo(ordered) : pairByElo(ordered, config, now);
}