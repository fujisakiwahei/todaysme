// =============================================================================
// Google Calendar 同期ヘルパ (Issue #39)
// SPEC §3 / §10.4 / §11.3
//
//   - `target_date` ± 1 日のウィンドウを Google Calendar API から取得し、
//     `google_calendar_events` に external id (`google_event_id`) 単位で
//     upsert する。
//   - 各 calendar 単位で取得し、calendar_name (= summaryOverride > summary) を
//     付与する。
//   - 差分同期で受信した `cancelled` イベント (deletedEventIds) は
//     `is_deleted = true` でソフトデリート (target_date 不問)。
//   - 加えて、対象日に紐づく既存行のうち取得結果に含まれないものも
//     ソフトデリートする (SPEC §11.3)。
//   - MVP では syncToken は永続化しない。毎回 timeMin/timeMax で全件再取得する。
// =============================================================================
import { getGoogleData } from "./getGoogleData";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { getDecryptedAccessToken } from "./serviceConnection";
import { ServiceNotConnectedError, softDeleteMissing } from "./syncOura";

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
  _timezone: string,
): Promise<void> {
  const accessToken = await getDecryptedAccessToken(userId, "google");
  if (!accessToken) {
    throw new ServiceNotConnectedError("google");
  }

  const { timeMin, timeMax } = dateBoundaries(targetDate);

  const { calendars } = await getGoogleData({
    accessToken,
    timezone: _timezone,
    timeMin,
    timeMax,
  });

  const admin = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  // 全カレンダーぶんの events をまとめて upsert する。
  const allFetched = calendars.flatMap((c) => c.events);
  if (allFetched.length > 0) {
    const rows = allFetched.map((e) => ({
      user_id: userId,
      target_date: e.target_date,
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
      .upsert(rows, { onConflict: "user_id,google_event_id" });
    if (upsertError) {
      throw new Error(
        `failed to upsert ${GOOGLE_CALENDAR_EVENTS}: ${upsertError.message}`,
      );
    }
  }

  // 差分同期で「削除」と通知された event は target_date 不問で is_deleted を立てる。
  const deletedEventIds = calendars.flatMap((c) => c.deletedEventIds);
  if (deletedEventIds.length > 0) {
    const { error: deleteError } = await admin
      .from(GOOGLE_CALENDAR_EVENTS)
      .update({ is_deleted: true, updated_at: nowIso })
      .eq("user_id", userId)
      .in("google_event_id", deletedEventIds);
    if (deleteError) {
      throw new Error(
        `failed to soft-delete cancelled events: ${deleteError.message}`,
      );
    }
  }

  // 対象日に紐づく既存行のうち、今回取得結果に含まれない event_id は
  // ソース側で消えた / 別日に移動したと見なしてソフトデリートする。
  const keepIds = new Set(allFetched.map((e) => e.google_event_id));
  await softDeleteMissing({
    table: GOOGLE_CALENDAR_EVENTS,
    externalIdCol: "google_event_id",
    userId,
    targetDate,
    keepIds,
  });
}
