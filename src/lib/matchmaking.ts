export type QueueEntry = {
  userId: string;
  createdAt: number;
  card: number[];
};

export function chooseQueueOpponent(
  entries: QueueEntry[],
  currentUserId: string,
): QueueEntry | null {
  const candidates = entries
    .filter((entry) => entry.userId !== currentUserId)
    .sort(
      (left, right) => left.createdAt - right.createdAt || left.userId.localeCompare(right.userId),
    );

  return candidates[0] ?? null;
}
