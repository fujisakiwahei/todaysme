// =============================================================================
// PUT /api/connections/google/excluded-calendars
// Issue #108 / Issue #131 Phase 5
//
//   稼働時間集計から除外する Google calendarId の配列を保存する。
//   Phase 5 以降は **接続 (connection_id) 単位** で管理する。
//
//   - 既存値を「置き換える」(差分パッチではない)。空配列を投げれば全解除。
//   - 重複は除き、ID は文字列 1〜200 件で受ける (Zod 側で validation)。
//   - Google 側に存在するか / 接続済みかはここでは検証しない。設定 UI が
//     カレンダー一覧から選ばせる前提で、ユーザーの自由入力導線は無い。
//   - 永続化先は `google_excluded_calendars` テーブル
//     (主キー: (connection_id, calendar_id))。
// =============================================================================
import {
  googleExcludedCalendarsUpdateRequestSchema,
  googleExcludedCalendarsUpdateResponseSchema,
} from "../../../../shared/schemas";
import { requireUserId } from "../../../utils/auth";
import { getSupabaseAdmin } from "../../../utils/supabaseAdmin";
import { parseOrThrow } from "../../../utils/validation";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const body = await readBody(event);
  const parsed = parseOrThrow(googleExcludedCalendarsUpdateRequestSchema, body);
  const connectionId = parsed.connection_id;

  const unique = Array.from(new Set(parsed.excluded_calendar_ids));

  const admin = getSupabaseAdmin();

  // 接続行が当該 user の Google 接続であることを admin client で確認。
  // RLS バイパス経路なので明示的に user_id でフィルタする。
  const { data: connRow, error: connErr } = await admin
    .from("service_connections")
    .select("id")
    .eq("id", connectionId)
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();
  if (connErr) {
    throw createError({
      statusCode: 500,
      statusMessage: `failed to load connection: ${connErr.message}`,
    });
  }
  if (!connRow) {
    throw createError({
      statusCode: 404,
      statusMessage: "google connection not found",
    });
  }

  // 「置換」セマンティクスを 2 ステップで実現する (Supabase JS から複数文の
  // transaction を直接張れないため)。
  //   1. 当該 (user_id, connection_id) の既存行をすべて delete
  //   2. unique の calendar_id 群を bulk insert
  // 2 ステップの間で短い不整合期間が生じうるが、対象は同 user × 同接続の
  // 除外設定のみで、稼働時間集計は次回 summary 取得時に最新版を読むため
  // 実害は無い。
  const { error: deleteError } = await admin
    .from("google_excluded_calendars")
    .delete()
    .eq("user_id", userId)
    .eq("connection_id", connectionId);
  if (deleteError) {
    throw createError({
      statusCode: 500,
      statusMessage: `failed to clear excluded calendars: ${deleteError.message}`,
    });
  }

  if (unique.length > 0) {
    const rows = unique.map((calendarId) => ({
      user_id: userId,
      connection_id: connectionId,
      calendar_id: calendarId,
    }));
    const { error: insertError } = await admin
      .from("google_excluded_calendars")
      .insert(rows);
    if (insertError) {
      throw createError({
        statusCode: 500,
        statusMessage: `failed to save excluded calendars: ${insertError.message}`,
      });
    }
  }

  return parseOrThrow(googleExcludedCalendarsUpdateResponseSchema, {
    connection_id: connectionId,
    excluded_calendar_ids: unique,
  });
});
