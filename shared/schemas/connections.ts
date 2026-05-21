// =============================================================================
// /api/connections I/O スキーマ
// SPEC §6 / §11.2 / §12.1 / Issue #52
//
//   - Oura / Google は OAuth2 で start → callback の 2 段。
//   - Toggl は API token を /settings から受け取り、サーバで暗号化して保存。
//   - サーバはトークン本体を **クライアントに返さない**。`hasToken` 等の真偽だけを公開する。
// =============================================================================
import { z } from "zod";

import {
  connectionStatusSchema,
  isoDateTimeSchema,
  serviceProviderSchema,
} from "./common";

// -----------------------------------------------------------------------------
// OAuth start (`GET /api/connections/<provider>/start`)
// -----------------------------------------------------------------------------

export const oauthStartResponseSchema = z.object({
  // ブラウザを遷移させる先 (Oura / Google の認可画面)
  authorize_url: z.url(),
});

// -----------------------------------------------------------------------------
// OAuth callback (`GET /api/connections/<provider>/callback`)
// Oura / Google が code か error のどちらかを乗せて返してくる。
// -----------------------------------------------------------------------------

export const oauthCallbackQuerySchema = z
  .object({
    code: z.string().min(1).optional(),
    state: z.string().min(1),
    error: z.string().min(1).optional(),
    error_description: z.string().optional(),
  })
  .refine((v) => v.code !== undefined || v.error !== undefined, {
    message: "either code or error must be present",
  });

// -----------------------------------------------------------------------------
// Toggl token 保存 (`POST /api/connections/toggl`)
// -----------------------------------------------------------------------------

export const togglConnectRequestSchema = z.object({
  // Toggl Track API token (Profile 画面で発行する 32 文字程度の hex 文字列)
  api_token: z.string().min(8).max(256),
});

// -----------------------------------------------------------------------------
// 切断 (`DELETE /api/connections/:provider`)
// -----------------------------------------------------------------------------

export const disconnectParamsSchema = z.object({
  provider: serviceProviderSchema,
});

// -----------------------------------------------------------------------------
// 連携状況の一覧 (`GET /api/connections`)
// 「接続済みか」「いつ繋いだか」だけを返す。トークン本体は絶対に乗せない。
// -----------------------------------------------------------------------------

export const connectionSummarySchema = z.object({
  provider: serviceProviderSchema,
  status: connectionStatusSchema,
  has_token: z.boolean(),
  connected_at: isoDateTimeSchema.nullable(),
  token_expires_at: isoDateTimeSchema.nullable(),
});

export const connectionListResponseSchema = z.object({
  connections: z.array(connectionSummarySchema),
});

// -----------------------------------------------------------------------------
// 型
// -----------------------------------------------------------------------------

export type OauthStartResponse = z.infer<typeof oauthStartResponseSchema>;
export type OauthCallbackQuery = z.infer<typeof oauthCallbackQuerySchema>;
export type TogglConnectRequest = z.infer<typeof togglConnectRequestSchema>;
export type DisconnectParams = z.infer<typeof disconnectParamsSchema>;
export type ConnectionSummary = z.infer<typeof connectionSummarySchema>;
export type ConnectionListResponse = z.infer<
  typeof connectionListResponseSchema
>;
