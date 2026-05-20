// =============================================================================
// Toggl Track API v9 レスポンススキーマ
// SPEC §3 / Issue #11 / #54
//
// `GET /me/time_entries` の最低限のフィールドだけを抜き出す。
// 進行中エントリは stop が null、duration が負値。
// =============================================================================
import { z } from "zod";

import { isoDateTimeSchema } from "./common.ts";

export const togglTimeEntrySchema = z.object({
  id: z.number().int(),
  description: z.string().nullable().optional(),
  start: isoDateTimeSchema,
  stop: isoDateTimeSchema.nullable().optional(),
  duration: z.number().int().optional(),
  workspace_id: z.number().int().optional(),
  project_id: z.number().int().nullable().optional(),
});

// /me/time_entries は配列レスポンス
export const togglTimeEntriesResponseSchema = z.array(togglTimeEntrySchema);

export type TogglTimeEntry = z.infer<typeof togglTimeEntrySchema>;
export type TogglTimeEntriesResponse = z.infer<
  typeof togglTimeEntriesResponseSchema
>;
