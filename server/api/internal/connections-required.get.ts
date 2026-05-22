// =============================================================================
// GET /api/internal/connections-required
//
//   /daily/* の require-connections middleware が「Oura / Google が接続済か」
//   を判定するための read-only エンドポイント。
//
//   - 認証は cookie ベース (serverSupabaseUser)。GET + SameSite cookie のため
//     CSRF にはならず、レスポンスもどのサービスが未接続かを返すだけで機密性
//     も低い。
//   - 既存の /api/connections (Bearer 必須) は SSR / hydration では SDK の
//     session token が間に合わずガードを擦り抜けるため、middleware からは
//     こちらを使う (Codex #104)。
// =============================================================================
import { serverSupabaseUser } from "#supabase/server";
import { createError, defineEventHandler } from "h3";

import {
  connectionsRequiredResponseSchema,
  type ServiceProvider,
} from "../../../shared/schemas";
import {
  pickPrimaryConnectionRow,
  listServiceConnections,
} from "../../utils/serviceConnection";
import { parseOrThrow } from "../../utils/validation";

// Oura の起床時刻 (wake_at) が無いと SPEC §4.2 の Wake-based Timeline が
// 成立しないので、Oura と Google Calendar は必須扱い。Toggl は欠けても可。
const REQUIRED_PROVIDERS: ServiceProvider[] = ["oura", "google"];

export default defineEventHandler(async (event) => {
  // @nuxtjs/supabase v2 の serverSupabaseUser は JwtPayload を返すので、
  // user id は `sub` クレームから取る (User オブジェクトの `id` ではない)。
  // app/pages/daily/today.vue でも同じ流儀。
  const user = await serverSupabaseUser(event);
  const userId = user?.sub;
  if (!userId) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }

  const rows = await listServiceConnections(userId);
  // Issue #131 Phase 4+: Google は同一ユーザーに 0..N 行存在しうるため、
  // 「最も active な 1 行」を決定的に選ぶ。1 つでも connected があれば
  // missing から外れる挙動になる。
  const missing = REQUIRED_PROVIDERS.filter(
    (p) => pickPrimaryConnectionRow(rows, p)?.status !== "connected",
  );

  return parseOrThrow(connectionsRequiredResponseSchema, { missing });
});
