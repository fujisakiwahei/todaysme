// =============================================================================
// Google Calendar 同期ヘルパ (Issue #39)
// SPEC §3 / §10.4 / §11.3
//
//   - `target_date` ± 1 日のウィンドウを Google Calendar API から取得し、
//     `google_calendar_events` に external id (`user_id, calendar_id,
//     google_event_id`) 単位で upsert する。
//   - Google `event.id` はカレンダー内ユニークなだけで、複数カレンダーから
//     同期するとカレンダー跨ぎで同じ ID が出現しうるため、calendar_id を
//     unique key に含める (Codex review 対応)。
//   - 各 calendar 単位で取得し、calendar_name (= summaryOverride > summary) を
//     付与する。
//   - 差分同期で受信した `cancelled` イベント (deletedEventIds) は
//     `is_deleted = true` でソフトデリート (calendar_id でスコープ)。
//   - 加えて、対象日に紐づく既存行のうち取得結果に含まれないものも
//     (calendar 単位で) ソフトデリートする (SPEC §11.3)。
//   - MVP では syncToken は永続化しない。毎回 timeMin/timeMax で全件再取得する。
//   - access_token は serviceConnection.ts の withFreshAccessToken 経由で取得し、
//     401 が返ったら 1 回だけ refresh して再試行する (Issue #75)。
// =============================================================================
import { getGoogleData } from "./getGoogleData";
import { withFreshAccessToken } from "./serviceConnection";
import { getSupabaseAdmin } from "./supabaseAdmin";

const GOOGLE_CALENDAR_EVENTS = "google_calendar_events";

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 対象日の前後 1 日を「現地時間 00:00」相当の UTC instant にざっくり丸めて
// timeMin/timeMax として渡す。Google API 側は inclusive/exclusive を意識した
// 比較で十分受け止めてくれるため、ここでは UTC 端点で OK。
function dateBoundaries(targetDate: string): {
  timeMin: string;
  timeMax: string;
} {
  const startDay = shiftDate(targetDate, -1);
  const endDay = shiftDate(targetDate, 2); // 翌々日 00:00 を上限 (exclusive 相当)
  return {
    timeMin: `${startDay}T00:00:00Z`,
    timeMax: `${endDay}T00:00:00Z`,
  };
}

export async function syncGoogleForDate(
  userId: string,
  targetDate: string,
  timezone: string,
): Promise<void> {
  const { timeMin, timeMax } = dateBoundaries(targetDate);

  const { calendars } = await withFreshAccessToken(
    userId,
    "google",
    (accessToken) =>
      getGoogleData({
        accessToken,
        timezone,
        timeMin,
        timeMax,
      }),
  );

  const admin = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  // 全カレンダーぶんの events をまとめて upsert する。
  // onConflict には (user_id, calendar_id, google_event_id) を使うことで、
  // event_id がカレンダー跨ぎで衝突しても別 row として扱う。
  const allFetched = calendars.flatMap((c) => c.events);
  if (allFetched.length > 0) {
    const rows = allFetched.map((e) => ({
      user_id: userId,
      target_date: e.target_date,
      calendar_id: e.calendar_id,
      google_event_id: e.google_event_id,
      calendar_name: e.calendar_name,
      title: e.title,
      start_at: e.start_at,
      end_at: e.end_at,
      is_deleted: false,
      updated_at: nowIso,
    }));

    const { error: upsertError } = await admin
      .from(GOOGLE_CALENDAR_EVENTS)
      .upsert(rows, {
        onConflict: "user_id,calendar_id,google_event_id",
      });
    if (upsertError) {
      throw new Error(
        `failed to upsert ${GOOGLE_CALENDAR_EVENTS}: ${upsertError.message}`,
      );
    }
  }

  // 差分同期で「削除」と通知された event は calendar_id でスコープして
  // is_deleted を立てる (event_id だけだと別カレンダーの同名 id を巻き込みうる)。
  for (const cal of calendars) {
    if (cal.deletedEventIds.length === 0) continue;
    const { error: deleteError } = await admin
      .from(GOOGLE_CALENDAR_EVENTS)
      .update({ is_deleted: true, updated_at: nowIso })
      .eq("user_id", userId)
      .eq("calendar_id", cal.calendarId)
      .in("google_event_id", cal.deletedEventIds);
    if (deleteError) {
      throw new Error(
        `failed to soft-delete cancelled events: ${deleteError.message}`,
      );
    }
  }

  // 対象日 × calendar_id 単位で、今回取得結果に含まれない event_id を
  // ソフトデリートする。calendar_id ごとに `keepIds` を作って絞り込まないと、
  // 「calendar A に存在しなくなったが calendar B にある」イベントを誤って
  // 削除してしまう。
  for (const cal of calendars) {
    const keepIds = new Set(cal.events.map((e) => e.google_event_id));
    await softDeleteMissingGoogleEvents({
      userId,
      targetDate,
      calendarId: cal.calendarId,
      keepIds,
    });
  }
}

interface SoftDeleteGoogleInput {
  userId: string;
  targetDate: string;
  calendarId: string;
  keepIds: Set<string>;
}

// google_calendar_events は (user_id, calendar_id, google_event_id) で unique。
// syncOura.ts の汎用 softDeleteMissing は単一 external id 前提なのでこちらは独自に書く。
async function softDeleteMissingGoogleEvents(
  input: SoftDeleteGoogleInput,
): Promise<void> {
  const admin = getSupabaseAdmin();

  const { data: existing, error: readError } = await admin
    .from(GOOGLE_CALENDAR_EVENTS)
    .select("google_event_id")
    .eq("user_id", input.userId)
    .eq("calendar_id", input.calendarId)
    .eq("target_date", input.targetDate)
    .eq("is_deleted", false);
  if (readError) {
    throw new Error(
      `failed to read ${GOOGLE_CALENDAR_EVENTS}: ${readError.message}`,
    );
  }

  const toDelete: string[] = [];
  for (const row of existing ?? []) {
    const record = row as unknown as Record<string, unknown>;
    const id = record["google_event_id"];
    if (typeof id === "string" && !input.keepIds.has(id)) {
      toDelete.push(id);
    }
  }
  if (toDelete.length === 0) return;

  const { error: updateError } = await admin
    .from(GOOGLE_CALENDAR_EVENTS)
    .update({ is_deleted: true, updated_at: new Date().toISOString() })
    .eq("user_id", input.userId)
    .eq("calendar_id", input.calendarId)
    .eq("target_date", input.targetDate)
    .in("google_event_id", toDelete);
  if (updateError) {
    throw new Error(
      `failed to soft-delete ${GOOGLE_CALENDAR_EVENTS}: ${updateError.message}`,
    );
  }
}
