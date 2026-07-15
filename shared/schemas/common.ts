// =============================================================================
// 共通 Zod スキーマ
// SPEC §12.3 / Issue #20 / #54
//
// ここには各サービス・各 API で使い回す primitive スキーマだけを置く。
// DB の text/enum 制約に揃えるため、ここで一度定義したものを必ず参照する。
// =============================================================================
import { z } from "zod";

// YYYY-MM-DD 形式の日付文字列
export const isoDateSchema = z.iso.date();

// オフセット付き ISO datetime (例: 2026-05-20T01:23:45+09:00)
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

// uuid (v4 想定だが他バージョンも許容)
export const uuidSchema = z.uuid();

// 外部サービスの識別子。
// service_connections.provider と daily_sync_statuses.source は同じ集合 (SPEC §11.x)
// todoist は Issue #206 (日記用 Markdown コピーの完了タスク) で追加。
export const serviceProviderSchema = z.enum(["oura", "google", "toggl", "todoist"]);

// daily_sync_statuses.status
export const syncStatusSchema = z.enum(["idle", "in_progress", "success", "failed"]);

// service_connections.status
//   - needs_reauth: Issue #131 Phase 2。OAuth scope の拡張 (openid email)
//     や id_token 検証フローへの移行で、既存トークンは生きているが
//     provider_user_id (sub) / account_email が未取得のため再認可を促す状態。
//     loadConnectionForToken はこの行を ServiceNotConnectedError として扱い、
//     settings UI が「再認可してください」バナーを出す。
export const connectionStatusSchema = z.enum([
  "connected",
  "disconnected",
  "error",
  "needs_reauth",
]);

// IANA タイムゾーン (DB は text)。'Asia/Tokyo' 等
export const timezoneSchema = z.string().min(1);

export type IsoDate = z.infer<typeof isoDateSchema>;
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;
export type Uuid = z.infer<typeof uuidSchema>;
export type ServiceProvider = z.infer<typeof serviceProviderSchema>;
export type SyncStatus = z.infer<typeof syncStatusSchema>;
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type Timezone = z.infer<typeof timezoneSchema>;
