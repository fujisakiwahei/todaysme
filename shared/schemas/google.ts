// =============================================================================
// Google Calendar API v3 レスポンススキーマ
// SPEC §3 / Issue #11 / #54
//
// `events.list` の最低限のフィールドだけを抜き出す。
// start/end は dateTime (時刻あり予定) または date (終日予定) のどちらか。
//
// `nextSyncToken` を使った差分同期 (SPEC §3) では、`status: "cancelled"` の
// 削除通知だけが返るケースがあり、その際は `id` 以外のフィールドが欠落しうる。
// SPEC のソフトデリート方針 (`is_deleted = true`) に沿って後段で削除処理に
// 回すため、cancelled の場合のみ start/end の欠落を許す。
// =============================================================================
import { z } from "zod";

import { isoDateSchema, isoDateTimeSchema } from "./common";

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

export const googleCalendarEventSchema = z
  .object({
    id: z.string(),
    status: z.enum(["confirmed", "tentative", "cancelled"]).optional(),
    summary: z.string().optional(),
    // cancelled イベントでは欠落するため optional。後段の superRefine で
    // 「cancelled 以外なら必須」を強制する。
    start: googleEventDateSchema.optional(),
    end: googleEventDateSchema.optional(),
  })
  .superRefine((event, ctx) => {
    if (event.status === "cancelled") return;
    if (event.start === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["start"],
        message: "start is required when status is not 'cancelled'",
      });
    }
    if (event.end === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["end"],
        message: "end is required when status is not 'cancelled'",
      });
    }
  });

export const googleEventsListResponseSchema = z.object({
  items: z.array(googleCalendarEventSchema),
  nextPageToken: z.string().optional(), // リクエストで返しきれない件数があるときのページネーションのようなもの
  nextSyncToken: z.string().optional(), // 次回の取得で、未取得のイベントだけを参照するために使う。「今回はここまで取得したよ」を表す。
});

export type GoogleCalendarEvent = z.infer<typeof googleCalendarEventSchema>;
export type GoogleEventsListResponse = z.infer<
  typeof googleEventsListResponseSchema
>;

// -----------------------------------------------------------------------------
// `POST https://oauth2.googleapis.com/token` のレスポンス (Issue #52)
// refresh_token は初回 (consent prompt 経由) のみ返ってくる。
// -----------------------------------------------------------------------------
export const googleTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  token_type: z.string().optional(),
  // 秒。Google は通常 3600。
  expires_in: z.number().int().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});

export type GoogleTokenResponse = z.infer<typeof googleTokenResponseSchema>;
