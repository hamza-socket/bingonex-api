import { z } from "zod";
import { GAME_IDS } from "./registery";

const gameId = z.enum(GAME_IDS);
const userId = z.union([z.string().min(1), z.number().finite()]);
const username = z.string().min(1);
const elo = z.number().finite();

export const registerTokenSchema = z.object({
  token: z.string().min(1),
  userId: z.number().finite(),
  username,
  elo,
  gameId,
});

export const joinSchema = z.object({
  gameId,
  userId,
  username,
  elo,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const statusQuerySchema = z.object({
  gameId,
  userId: z.string().min(1),
});

export const cancelSchema = z.object({ gameId, userId });

export const ackSchema = cancelSchema.extend({ matchId: z.string().min(1) });

export const clientMessageSchema = z.object({ type: z.literal("cancel") });

export const playerAttachmentSchema = z.object({ gameId: z.string(), userId });