// =============================================================================
// Oura API v2 レスポンススキーマ
// SPEC §3 / Issue #11 / #54
//
// MVP で使う最小範囲のみ定義する。他フィールドは passthrough せず無視するが、
// 将来必要になったらこのファイルにフィールドを追加する。
// =============================================================================
import { z } from "zod";

import { isoDateSchema, isoDateTimeSchema } from "./common";

// `GET /v2/usercollection/sleep` の各エントリ
// https://cloud.ouraring.com/v2/docs#tag/Sleep-Routes
export const ouraSleepItemSchema = z.object({
  id: z.string(),
  // 起床日 (Oura は wake 日を `day` として返す)
  day: isoDateSchema,
  bedtime_start: isoDateTimeSchema,
  bedtime_end: isoDateTimeSchema,
  // 秒単位。欠損する個体差を許容
  total_sleep_duration: z.number().int().nullable().optional(),
});

export const ouraSleepResponseSchema = z.object({
  data: z.array(ouraSleepItemSchema),
  next_token: z.string().nullable().optional(),
});

export type OuraSleepItem = z.infer<typeof ouraSleepItemSchema>;
export type OuraSleepResponse = z.infer<typeof ouraSleepResponseSchema>;
