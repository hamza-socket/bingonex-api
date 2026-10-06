import type { QueueEntry, StoredMatch, TokenData, UserId } from "../types/types";

const BATCH_LIMIT = 128;

const encode = (value: UserId): string => encodeURIComponent(String(value));
const queueKey = (gameId: string, userId: UserId): string => `queue:${gameId}:${encode(userId)}`;
const matchKey = (gameId: string, userId: UserId): string => `match:${gameId}:${encode(userId)}`;
const tokenKey = (token: string): string => `token:${token}`;

export class MatchmakingStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  getQueueEntry(gameId: string, userId: UserId): Promise<QueueEntry | undefined> {
    return this.storage.get<QueueEntry>(queueKey(gameId, userId));
  }

  async putQueueEntry(entry: QueueEntry): Promise<void> {
    await this.storage.put(queueKey(entry.gameId, entry.userId), entry);
  }

  async deleteQueueEntry(gameId: string, userId: UserId): Promise<void> {
    await this.storage.delete(queueKey(gameId, userId));
  }

  async deleteQueueEntries(entries: readonly QueueEntry[]): Promise<void> {
    await this.deleteMany(entries.map((entry) => queueKey(entry.gameId, entry.userId)));
  }

  async listQueue(gameId?: string): Promise<QueueEntry[]> {
    const prefix = gameId ? `queue:${gameId}:` : "queue:";
    const entries = await this.storage.list<QueueEntry>({ prefix });
    return [...entries.values()];
  }

  getMatch(gameId: string, userId: UserId): Promise<StoredMatch | undefined> {
    return this.storage.get<StoredMatch>(matchKey(gameId, userId));
  }

  async putMatch(gameId: string, userId: UserId, match: StoredMatch): Promise<void> {
    await this.storage.put(matchKey(gameId, userId), match);
  }

  async deleteMatch(gameId: string, userId: UserId): Promise<void> {
    await this.storage.delete(matchKey(gameId, userId));
  }

  getToken(token: string): Promise<TokenData | undefined> {
    return this.storage.get<TokenData>(tokenKey(token));
  }

  async putToken(token: string, data: TokenData): Promise<void> {
    await this.storage.put(tokenKey(token), data);
  }

  async deleteToken(token: string): Promise<void> {
    await this.storage.delete(tokenKey(token));
  }

  async purgeTokens(now: number): Promise<void> {
    await this.deleteWhere<TokenData>("token:", (token) => token.expiresAt <= now);
  }

  async purgeMatches(cutoff: number): Promise<void> {
    await this.deleteWhere<StoredMatch>("match:", (match) => match.matchedAt <= cutoff);
  }

  async hasWork(): Promise<boolean> {
    const keys = await this.storage.list({ limit: 1 });
    return keys.size > 0;
  }

  private async deleteWhere<T>(prefix: string, predicate: (value: T) => boolean): Promise<void> {
    const entries = await this.storage.list<T>({ prefix });
    const doomed = [...entries].filter(([, value]) => predicate(value)).map(([key]) => key);
    await this.deleteMany(doomed);
  }

  private async deleteMany(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += BATCH_LIMIT) {
      await this.storage.delete(keys.slice(i, i + BATCH_LIMIT));
    }
  }
}