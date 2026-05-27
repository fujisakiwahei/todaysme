// =============================================================================
// API エラーレスポンス共通スキーマ
// SPEC §9.2: 部分失敗を許容し、失敗したサービス名とエラー内容を返す
// =============================================================================
import { z } from "zod";

import { serviceProviderSchema } from "./common";

export const apiErrorItemSchema = z.object({
  service: serviceProviderSchema,
  message: z.string(),
});

export const apiErrorResponseSchema = z.object({
  errors: z.array(apiErrorItemSchema),
});

export type ApiErrorItem = z.infer<typeof apiErrorItemSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

// -----------------------------------------------------------------------------
// Toggl レート制限マーカー (Issue #185)
//   Toggl API は 1 時間あたり 30 リクエスト上限を超えると 429 を返す。
//   サーバ側で 429 を検知したら error_message の先頭に
//   `TOGGL_RATE_LIMIT_MARKER` を付ける。クライアントはこの prefix を
//   識別して「少し待ってリロードを促す」専用バナーに切り替える。
//   日本語本文・UI 表示は app/components/DailySummaryView.vue 側で扱う。
// -----------------------------------------------------------------------------
export const TOGGL_RATE_LIMIT_MARKER = "[TOGGL_RATE_LIMIT]";

export function isTogglRateLimitMessage(message: string | null | undefined): boolean {
  return !!message && message.startsWith(TOGGL_RATE_LIMIT_MARKER);
}

export function stripTogglRateLimitMarker(message: string): string {
  return message.startsWith(TOGGL_RATE_LIMIT_MARKER)
    ? message.slice(TOGGL_RATE_LIMIT_MARKER.length).trimStart()
    : message;
}
