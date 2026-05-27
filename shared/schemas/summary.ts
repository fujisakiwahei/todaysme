// =============================================================================
// /api/summary I/O スキーマ
// SPEC §4 / §9.1 / §9.2 / §10.4 / Issue #54
//
//   GET  /api/summary?date=YYYY-MM-DD
//   POST /api/summary/refresh
//
// MVP の骨組みとして必要最小限の構造を定義する。
// 各 lane のレコードは「DB 行のサブセット + UI で必要な集計」になる想定。
// =============================================================================
import { z } from "zod";

import {
  isoDateSchema,
  isoDateTimeSchema,
  serviceProviderSchema,
  syncStatusSchema,
  timezoneSchema,
  uuidSchema,
} from "./common";
import { apiErrorItemSchema } from "./errors";

// -----------------------------------------------------------------------------
// リクエスト
// -----------------------------------------------------------------------------

export const summaryRequestSchema = z.object({
  // ルーティングでは /daily/today も受けるが、API は YYYY-MM-DD のみ受ける。
  // `today` の解決はクライアント側で済ませる。
  date: isoDateSchema,
});

export const summaryRefreshRequestSchema = z.object({
  date: isoDateSchema,
});

// -----------------------------------------------------------------------------
// Wake-based Timeline (SPEC §4.2)
// -----------------------------------------------------------------------------

export const sleepTimelineEntrySchema = z.object({
  id: uuidSchema,
  sleep_start_at: isoDateTimeSchema,
  wake_at: isoDateTimeSchema,
  sleep_minutes: z.number().int().nullable(),
});

export const calendarTimelineEntrySchema = z.object({
  id: uuidSchema,
  google_event_id: z.string(),
  // 除外設定 (users.excluded_google_calendar_ids / Issue #108) で照合するための
  // Google calendarId。デモは calendar_id を保持しないため null を許容する。
  calendar_id: z.string().nullable(),
  calendar_name: z.string().nullable(),
  title: z.string().nullable(),
  start_at: isoDateTimeSchema,
  end_at: isoDateTimeSchema,
  // 稼働時間集計から除外されたイベントは UI 側で薄く表示する (Issue #108)。
  is_excluded: z.boolean(),
});

export const togglTimelineEntrySchema = z.object({
  id: uuidSchema,
  toggl_entry_id: z.string(),
  title: z.string().nullable(),
  // Issue #112: time entry に紐づく Toggl プロジェクト。未割当 / 解決失敗時は null。
  project_id: z.number().int().nullable(),
  project_name: z.string().nullable(),
  start_at: isoDateTimeSchema,
  // 進行中エントリは null
  end_at: isoDateTimeSchema.nullable(),
});

export const timelineSchema = z.object({
  sleep: z.array(sleepTimelineEntrySchema),
  calendar: z.array(calendarTimelineEntrySchema),
  toggl: z.array(togglTimelineEntrySchema),
});

// -----------------------------------------------------------------------------
// Today's ME (SPEC §4.1)
// -----------------------------------------------------------------------------

export const todaysMeOuraSchema = z.object({
  // Oura `total_sleep_duration` を分換算した「実際に寝た時間」。
  sleep_minutes: z.number().int().nullable(),
  // bedtime_start → bedtime_end (= sleep_start_at → wake_at) の長さ。
  // 「ベッドにいた時間」として sleep_minutes と並べて表示する (dashboard Oura)。
  time_in_bed_minutes: z.number().int().nullable(),
  wake_at: isoDateTimeSchema.nullable(),
});

export const todaysMeGoogleSchema = z.object({
  total_minutes: z.number().int(),
  by_calendar: z.array(
    z.object({
      calendar_name: z.string(),
      minutes: z.number().int(),
    })
  ),
});

export const todaysMeTogglSchema = z.object({
  total_minutes: z.number().int(),
  // Issue #112: 同じタイトルでも別プロジェクトに紐付くものは別エントリに分け、
  // 各エントリにプロジェクト名 (未割当は null) を持たせる。
  by_title: z.array(
    z.object({
      title: z.string(),
      project_name: z.string().nullable(),
      minutes: z.number().int(),
    })
  ),
});

export const todaysMeSchema = z.object({
  // 各サービス未連携時は null
  oura: todaysMeOuraSchema.nullable(),
  google: todaysMeGoogleSchema.nullable(),
  toggl: todaysMeTogglSchema.nullable(),
});

// -----------------------------------------------------------------------------
// 同期状態 (daily_sync_statuses のサブセット)
// -----------------------------------------------------------------------------

export const syncStatusEntrySchema = z.object({
  source: serviceProviderSchema,
  status: syncStatusSchema,
  last_synced_at: isoDateTimeSchema.nullable(),
  error_message: z.string().nullable(),
});

// -----------------------------------------------------------------------------
// レスポンス
// -----------------------------------------------------------------------------

export const wakeRangeSchema = z.object({
  start: isoDateTimeSchema,
  end: isoDateTimeSchema,
});

export const summaryResponseSchema = z.object({
  target_date: isoDateSchema,
  timezone: timezoneSchema,
  // 対象日の wake 記録が無い場合は null
  wake_range: wakeRangeSchema.nullable(),
  todays_me: todaysMeSchema,
  timeline: timelineSchema,
  sync_statuses: z.array(syncStatusEntrySchema),
  // 部分失敗時に乗せる (SPEC §9.2)
  errors: z.array(apiErrorItemSchema).optional(),
});

export const summaryRefreshResponseSchema = z.object({
  target_date: isoDateSchema,
  sync_statuses: z.array(syncStatusEntrySchema),
  errors: z.array(apiErrorItemSchema).optional(),
});

// -----------------------------------------------------------------------------
// 型エクスポート
// -----------------------------------------------------------------------------

export type SummaryRequest = z.infer<typeof summaryRequestSchema>;
export type SummaryResponse = z.infer<typeof summaryResponseSchema>;
export type SummaryRefreshRequest = z.infer<typeof summaryRefreshRequestSchema>;
export type SummaryRefreshResponse = z.infer<typeof summaryRefreshResponseSchema>;
export type SleepTimelineEntry = z.infer<typeof sleepTimelineEntrySchema>;
export type CalendarTimelineEntry = z.infer<typeof calendarTimelineEntrySchema>;
export type TogglTimelineEntry = z.infer<typeof togglTimelineEntrySchema>;
export type Timeline = z.infer<typeof timelineSchema>;
export type TodaysMe = z.infer<typeof todaysMeSchema>;
export type SyncStatusEntry = z.infer<typeof syncStatusEntrySchema>;
export type WakeRange = z.infer<typeof wakeRangeSchema>;
