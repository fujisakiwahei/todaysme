// =============================================================================
// PUT /api/connections/google/excluded-calendars
// Issue #108
//
//   稼働時間集計から除外する Google calendarId の配列を保存する。
//
//   - 既存値を「置き換える」(差分パッチではない)。空配列を投げれば全解除。
//   - 重複は除き、ID は文字列 1〜200 件で受ける (Zod 側で validation)。
//   - Google 側に存在するか / 接続済みかはここでは検証しない。設定 UI が
//     カレンダー一覧から選ばせる前提で、ユーザーの自由入力導線は無い。
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

  const unique = Array.from(new Set(parsed.excluded_calendar_ids));

  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from("users")
    .update({ excluded_google_calendar_ids: unique })
    .eq("id", userId);

  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: `failed to update excluded calendars: ${error.message}`,
    });
  }

  return parseOrThrow(googleExcludedCalendarsUpdateResponseSchema, {
    excluded_calendar_ids: unique,
  });
});
