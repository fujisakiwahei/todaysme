// =============================================================================
// Google Calendar API v3 レスポンススキーマ
// SPEC §3 / Issue #11 / #54
//
// `events.list` の最低限のフィールドだけを抜き出す。
// start/end は dateTime (時刻あり予定) または date (終日予定) のどちらか。
// =============================================================================
import { z } from "zod";

import { isoDateSchema, isoDateTimeSchema } from "./common.ts";

const googleEventDateSchema = z
  .object({
    dateTime: isoDateTimeSchema.optional(),
    date: isoDateSchema.optional(),
    timeZone: z.string().optional(),
  })
  // dateTime も date もない start/end は不正
  .refine((v) => v.dateTime !== undefined || v.date !== undefined, {
    message: "either dateTime or date must be set",
  });

export const googleCalendarEventSchema = z.object({
  id: z.string(),
  status: z.enum(["confirmed", "tentative", "cancelled"]).optional(),
  summary: z.string().optional(),
  start: googleEventDateSchema,
  end: googleEventDateSchema,
});

export const googleEventsListResponseSchema = z.object({
  items: z.array(googleCalendarEventSchema),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
});

export type GoogleCalendarEvent = z.infer<typeof googleCalendarEventSchema>;
export type GoogleEventsListResponse = z.infer<
  typeof googleEventsListResponseSchema
>;
