// =============================================================================
// Toggl Track 同期ヘルパ (Issue #39)
// SPEC §3 / §10.4 / §11.3
//
//   - 対象日 ± 1 日のウィンドウに収まる時間エントリを取得し、
//     `toggl_time_entries` に external id (`toggl_entry_id`) 単位で upsert する。
//   - Toggl API v9 `/me/time_entries` は `since` (UNIX 秒) で差分同期するため、
//     `since = 対象日 - 2 日` (UTC 00:00) を渡し、結果から target_date が
//     ウィンドウ外のものを捨てる。
//   - 取得結果に含まれない `target_date == 対象日` の既存レコードは
//     `is_deleted = true` でソフトデリート (SPEC §11.3)。
// =============================================================================
import { getTogglData } from "./getTogglData";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { getDecryptedAccessToken } from "./serviceConnection";
import { ServiceNotConnectedError, softDeleteMissing } from "./syncOura";

const TOGGL_TIME_ENTRIES = "toggl_time_entries";

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function syncTogglForDate(
  userId: string,
  targetDate: string,
  timezone: string,
): Promise<void> {
  const apiToken = await getDecryptedAccessToken(userId, "toggl");
  if (!apiToken) {
    throw new ServiceNotConnectedError("toggl");
  }

  // 対象日の 2 日前から差分取得を始める (`at` ベースなので保守的に広めに取る)。
  const sinceDate = shiftDate(targetDate, -2);
  const since = new Date(`${sinceDate}T00:00:00Z`);
  const windowStart = shiftDate(targetDate, -1);
  const windowEnd = shiftDate(targetDate, 1);

  const fetched = await getTogglData({
    apiToken,
    timezone,
    since,
  });

  // 対象日近辺だけ DB に書く (since ベースで余計な過去エントリも返るため)。
  const inWindow = fetched.filter(
    (e) => e.target_date >= windowStart && e.target_date <= windowEnd,
  );

  const admin = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  if (inWindow.length > 0) {
    const rows = inWindow.map((e) => ({
      user_id: userId,
      target_date: e.target_date,
      toggl_entry_id: e.toggl_entry_id,
      title: e.title,
      start_at: e.start_at,
      end_at: e.end_at,
      is_deleted: false,
      updated_at: nowIso,
    }));

    const { error: upsertError } = await admin
      .from(TOGGL_TIME_ENTRIES)
      .upsert(rows, { onConflict: "user_id,toggl_entry_id" });
    if (upsertError) {
      throw new Error(
        `failed to upsert ${TOGGL_TIME_ENTRIES}: ${upsertError.message}`,
      );
    }
  }

  const keepIds = new Set(inWindow.map((e) => e.toggl_entry_id));
  await softDeleteMissing({
    table: TOGGL_TIME_ENTRIES,
    externalIdCol: "toggl_entry_id",
    userId,
    targetDate,
    keepIds,
  });
}
