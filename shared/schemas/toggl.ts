// =============================================================================
// Toggl Track API v9 レスポンススキーマ
// SPEC §3 / Issue #11 / #54
//
// `GET /me/time_entries` の最低限のフィールドだけを抜き出す。
// 進行中エントリは stop が null、duration が負値。
// =============================================================================
import { z } from "zod";

import { isoDateTimeSchema } from "./common";

export const togglTimeEntrySchema = z.object({
  id: z.number().int(),
  description: z.string().nullable().optional(),
  start: isoDateTimeSchema,
  stop: isoDateTimeSchema.nullable().optional(),
  duration: z.number().int().optional(),
  workspace_id: z.number().int().optional(),
  project_id: z.number().int().nullable().optional(),
  // 最終更新時刻。Toggl の `since` ベースのページング (1 リクエスト 1000 件
  // 上限) を進めるためのカーソルとして使う。
  at: isoDateTimeSchema,
  // 削除済みエントリは `server_deleted_at` が非 null で返る (Issue #39)。
  // `since` ベース取得時に削除通知として返されるため、必ず取り込んで
  // 呼び出し側でソフトデリート判定に使えるようにしておく。
  server_deleted_at: isoDateTimeSchema.nullable().optional(),
});

// /me/time_entries は配列レスポンス
export const togglTimeEntriesResponseSchema = z.array(togglTimeEntrySchema);

export type TogglTimeEntry = z.infer<typeof togglTimeEntrySchema>;
export type TogglTimeEntriesResponse = z.infer<
  typeof togglTimeEntriesResponseSchema
>;
