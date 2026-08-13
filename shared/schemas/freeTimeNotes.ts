import { z } from "zod";

import { isoDateSchema, isoDateTimeSchema, uuidSchema } from "./common";

export const freeTimeNoteContentSchema = z.string().trim().min(1).max(1000);

export const freeTimeNoteSchema = z.object({
  id: uuidSchema,
  target_date: isoDateSchema,
  gap_start_at: isoDateTimeSchema,
  gap_end_at: isoDateTimeSchema,
  content: freeTimeNoteContentSchema,
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
});

export const freeTimeNoteCreateRequestSchema = z.object({
  target_date: isoDateSchema,
  gap_start_at: isoDateTimeSchema,
  gap_end_at: isoDateTimeSchema,
  content: freeTimeNoteContentSchema,
});

export const freeTimeNoteUpdateRequestSchema = z.object({
  content: freeTimeNoteContentSchema,
});

export const freeTimeNoteParamsSchema = z.object({
  id: uuidSchema,
});

export const freeTimeNoteMutationResponseSchema = z.object({
  note: freeTimeNoteSchema,
});

export const freeTimeNoteDeleteResponseSchema = z.object({
  ok: z.literal(true),
});

export type FreeTimeNote = z.infer<typeof freeTimeNoteSchema>;
export type FreeTimeNoteCreateRequest = z.infer<typeof freeTimeNoteCreateRequestSchema>;
export type FreeTimeNoteUpdateRequest = z.infer<typeof freeTimeNoteUpdateRequestSchema>;
export type FreeTimeNoteParams = z.infer<typeof freeTimeNoteParamsSchema>;
export type FreeTimeNoteMutationResponse = z.infer<typeof freeTimeNoteMutationResponseSchema>;
export type FreeTimeNoteDeleteResponse = z.infer<typeof freeTimeNoteDeleteResponseSchema>;
