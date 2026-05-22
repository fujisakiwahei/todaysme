// =============================================================================
// GET /api/connections/google/accounts
// Issue #131 Phase 3
//
//   ログイン中ユーザーに紐づく Google 接続行を 0..N 件返す。複数 Google
//   アカウント連携の設定 UI が「アカウントごとの行」を描画するためのエンドポイント。
//
//   - 平文トークンは返さない (`has_token` の真偽だけ)。
//   - 並び順は connected_at (古い順)。最初に繋いだメインアカウントが
//     先頭に来る挙動 (UI 上のチラつきを抑える)。
// =============================================================================
import {
  googleAccountsResponseSchema,
  type GoogleAccount,
} from "../../../../shared/schemas";
import { requireUserId } from "../../../utils/auth";
import { getSupabaseAdmin } from "../../../utils/supabaseAdmin";
import { parseOrThrow } from "../../../utils/validation";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const admin = getSupabaseAdmin();

  const { data, error } = await admin
    .from("service_connections")
    .select(
      "id, provider_user_id, account_email, status, access_token_encrypted, connected_at, token_expires_at",
    )
    .eq("user_id", userId)
    .eq("provider", "google")
    .order("connected_at", { ascending: true });

  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: `failed to load google accounts: ${error.message}`,
    });
  }

  const accounts: GoogleAccount[] = (data ?? []).map((row) => {
    // row は any 相当のため型安全のために絞り込む。
    const r = row as {
      id: string;
      provider_user_id: string | null;
      account_email: string | null;
      status: GoogleAccount["status"];
      access_token_encrypted: string | null;
      connected_at: string;
      token_expires_at: string | null;
    };
    return {
      connection_id: r.id,
      provider_user_id: r.provider_user_id,
      account_email: r.account_email,
      status: r.status,
      has_token: r.access_token_encrypted !== null,
      connected_at: r.connected_at,
      token_expires_at: r.token_expires_at,
    };
  });

  return parseOrThrow(googleAccountsResponseSchema, { accounts });
});
