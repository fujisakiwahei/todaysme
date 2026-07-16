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

// 同一 target_date に起床した睡眠セッション 1 件分 (起床①②… の内訳)。
// 二度寝・仮眠があると 1 日に複数セッションが並ぶ。
export const todaysMeOuraSessionSchema = z.object({
  sleep_start_at: isoDateTimeSchema,
  wake_at: isoDateTimeSchema,
  // Oura `total_sleep_duration` を分換算した「実際に寝た時間」。欠損は null。
  sleep_minutes: z.number().int().nullable(),
  // sleep_start_at → wake_at の長さ (ベッドにいた時間)。
  time_in_bed_minutes: z.number().int(),
});

export const todaysMeOuraSchema = z.object({
  // Oura `total_sleep_duration` を分換算した「実際に寝た時間」。
  // 同一 target_date に複数セッション (二度寝・仮眠) がある場合は合算値。
  sleep_minutes: z.number().int().nullable(),
  // bedtime_start → bedtime_end (= sleep_start_at → wake_at) の長さ。
  // 「ベッドにいた時間」として sleep_minutes と並べて表示する (dashboard Oura)。
  // こちらも複数セッションある場合は合算値。
  time_in_bed_minutes: z.number().int().nullable(),
  // その日最初の起床時刻 (= wake range の開始)。
  wake_at: isoDateTimeSchema.nullable(),
  // 起床時刻の昇順。1 件のときも配列で返す (UI 側で「起床①②」表示に使う)。
  sessions: z.array(todaysMeOuraSessionSchema),
});

export const todaysMeGoogleSchema = z.object({
  total_minutes: z.number().int(),
  // Issue #201: ダッシュボードの metric--calendar カードで「未到達 / 進行中 /
  // 完了」を絵文字付きで一覧表示するため、target_date (ユーザータイムゾーン)
  // の 00:00–24:00 に重なる予定を返す。wake range 外の未来予定もここに含めるが、
  // 集計値 (total_minutes) は従来通り wake range 内のみで計算する。
  events: z.array(calendarTimelineEntrySchema),
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

// Issue #206: 日記用 Markdown の「完了タスク」セクション用。タイムラインには
// 出さない (ユーザー決定) ため、集計値ではなく完了タスクの列挙のみを持つ。
export const todaysMeTodoistSchema = z.object({
  completed: z.array(
    z.object({
      content: z.string(),
      project_name: z.string().nullable(),
      completed_at: isoDateTimeSchema,
    })
  ),
});

export const todaysMeSchema = z.object({
  // 各サービス未連携時は null
  oura: todaysMeOuraSchema.nullable(),
  google: todaysMeGoogleSchema.nullable(),
  toggl: todaysMeTogglSchema.nullable(),
  todoist: todaysMeTodoistSchema.nullable(),
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
export type TodaysMeOuraSession = z.infer<typeof todaysMeOuraSessionSchema>;
export type CalendarTimelineEntry = z.infer<typeof calendarTimelineEntrySchema>;
export type TogglTimelineEntry = z.infer<typeof togglTimelineEntrySchema>;
export type Timeline = z.infer<typeof timelineSchema>;
export type TodaysMe = z.infer<typeof todaysMeSchema>;
export type TodaysMeTodoist = z.infer<typeof todaysMeTodoistSchema>;
export type SyncStatusEntry = z.infer<typeof syncStatusEntrySchema>;
export type WakeRange = z.infer<typeof wakeRangeSchema>;
