// =============================================================================
// Toggl Track 同期ヘルパ (Issue #39)
// SPEC §3 / §10.4 / §11.3
//
//   - `target_date` ± 1 日に「開始した」エントリを Toggl API から取得し、
//     `toggl_time_entries` に external id (`toggl_entry_id`) 単位で upsert する。
//   - Toggl API v9 の `start_date` / `end_date` (start_date inclusive,
//     end_date exclusive) を使うことで、修正日時ベースの `since` 取得とは
//     違って「ウィンドウに開始時刻がある全エントリ」を確実に得られる
//     (Codex review: since はあくまで modified-since で、未編集の既存エントリを
//     拾い漏れて soft-delete されてしまう問題があった)。
//   - 取得結果に含まれない `target_date == 対象日` の既存レコードは
//     `is_deleted = true` でソフトデリート (SPEC §11.3)。
//   - Toggl 側で削除されたエントリ (`server_deleted_at` が非 null) は
//     upsert 時点で `is_deleted = true` を立てる (keepIds にも入れない)。
//   - access_token は serviceConnection.ts 経由で取得し、平文はログ / 戻り値に
//     出さない (SPEC §12.1)。Toggl は API token 方式なので refresh は無いが、
//     一貫性のため withFreshAccessToken を使う。
// =============================================================================
import {
  buildProjectNameMap,
  enrichWithProjectNames,
  getTogglData,
  getTogglProjects,
} from "./getTogglData";
import {
  ServiceNotConnectedError,
  withFreshAccessToken,
} from "./serviceConnection";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { softDeleteMissing } from "./syncOura";

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
  // 対象日 ± 1 日のウィンドウ。Toggl の end_date は exclusive のため、
  // 「target_date + 1 日を含めたい」場合は target_date + 2 を渡す。
  const startDate = shiftDate(targetDate, -1);
  // end_date は exclusive なので target_date + 1 までを含めるには +2
  const endDate = shiftDate(targetDate, 2);

  let fetched;
  try {
    fetched = await withFreshAccessToken(userId, "toggl", async (apiToken) => {
      // time entries と projects を並列取得し、project_id → name を解決する
      // (Issue #112)。projects 取得が失敗した場合でも、entry 自体は表示できる
      // ようにしたいが、ここでは「整合性の取れた状態」を優先してハードエラーに
      // する (entry 同期は成功 / project 名だけ NULL より、全体 retry の方が
      // 単純で予測可能)。MVP の規模では projects API はほぼ常に成功する想定。
      const [entries, projects] = await Promise.all([
        getTogglData({
          apiToken,
          timezone,
          startDate,
          endDate,
        }),
        getTogglProjects(apiToken),
      ]);
      const projectNameById = buildProjectNameMap(projects);
      return enrichWithProjectNames(entries, projectNameById);
    });
  } catch (e) {
    // ServiceNotConnectedError はそのまま伝搬させる (呼び出し側で failed と記録)。
    if (e instanceof ServiceNotConnectedError) throw e;
    throw e;
  }

  const admin = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  // Toggl 側で削除済みフラグが立っている row は upsert 時点で is_deleted=true。
  // それ以外は生存エントリとして扱う。
  if (fetched.length > 0) {
    const rows = fetched.map((e) => ({
      user_id: userId,
      target_date: e.target_date,
      toggl_entry_id: e.toggl_entry_id,
      title: e.title,
      start_at: e.start_at,
      end_at: e.end_at,
      // Issue #112: project_id / project_name は nullable。Toggl 側で project
      // 未割当のエントリは null のまま。
      project_id: e.project_id,
      project_name: e.project_name,
      is_deleted: e.server_deleted_at !== null,
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

  // 「対象日に紐づく生存エントリ」だけを keepIds に入れる。
  // Toggl 側で削除された (= server_deleted_at が立っている) ものを keepIds に
  // 入れてしまうと、上で is_deleted=true にしたばかりの行を「生存とみなして
  // ソフトデリート対象から外す」ことになり整合性が崩れるため除外する。
  const keepIds = new Set(
    fetched
      .filter((e) => e.server_deleted_at === null)
      .map((e) => e.toggl_entry_id),
  );
  await softDeleteMissing({
    table: TOGGL_TIME_ENTRIES,
    externalIdCol: "toggl_entry_id",
    userId,
    targetDate,
    keepIds,
  });
}
