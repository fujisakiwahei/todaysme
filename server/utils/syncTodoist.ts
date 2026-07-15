// =============================================================================
// Todoist 同期ヘルパ (Issue #206)
//
//   - `target_date` ± 1 日 (UTC 基準の 3 日ウィンドウ) の完了タスクを
//     Todoist API から取得し、`todoist_completed_tasks` に合成キー
//     (`todoist_event_key` = task_id + completed_at) 単位で upsert する。
//     ユーザータイムゾーンの UTC オフセットは最大 ±24h に収まるため、
//     この UTC ウィンドウで「対象日 (ユーザー TZ) の完了タスク」を
//     取りこぼしなくカバーできる (syncToggl の ±1 日ウィンドウと同じ発想)。
//   - 取得結果に含まれない `target_date == 対象日` の既存レコードは
//     `is_deleted = true` でソフトデリート (SPEC §11.3)。Todoist 側で
//     「完了を取り消した」タスクがこれで消える。
//   - API token は serviceConnection.ts 経由で取得し、平文はログ / 戻り値に
//     出さない (SPEC §12.1)。Toggl と同じく refresh 概念は無いが、一貫性のため
//     withFreshAccessTokenFromRow を使う。
// =============================================================================
import {
  buildTodoistProjectNameMap,
  enrichWithTodoistProjectNames,
  getTodoistCompletedTasks,
  getTodoistProjects,
} from "./getTodoistData";
import { withFreshAccessTokenFromRow, type ServiceConnectionTokenRow } from "./serviceConnection";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { softDeleteMissing } from "./syncOura";

const TODOIST_COMPLETED_TASKS = "todoist_completed_tasks";

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function syncTodoistForDate(
  userId: string,
  targetDate: string,
  timezone: string,
  connectionRow: ServiceConnectionTokenRow
): Promise<void> {
  // since は inclusive / until は exclusive。target_date - 1 日の 00:00 UTC から
  // target_date + 2 日の 00:00 UTC までで、対象日 (ユーザー TZ) を必ず含む。
  const sinceIso = `${shiftDate(targetDate, -1)}T00:00:00Z`;
  const untilIso = `${shiftDate(targetDate, 2)}T00:00:00Z`;

  const fetched = await withFreshAccessTokenFromRow(connectionRow, async (apiToken) => {
    // 完了タスクと projects を並列取得し、project_id → name を解決する。
    // projects 取得失敗時はハードエラーにして全体 retry に任せる
    // (syncToggl と同じ判断: 整合性の取れた状態を優先する)。
    const [tasks, projects] = await Promise.all([
      getTodoistCompletedTasks({
        apiToken,
        timezone,
        sinceIso,
        untilIso,
      }),
      getTodoistProjects(apiToken),
    ]);
    const projectNameById = buildTodoistProjectNameMap(projects);
    return enrichWithTodoistProjectNames(tasks, projectNameById);
  });

  const admin = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  if (fetched.length > 0) {
    const rows = fetched.map((t) => ({
      user_id: userId,
      target_date: t.target_date,
      todoist_event_key: t.todoist_event_key,
      todoist_task_id: t.todoist_task_id,
      content: t.content,
      project_id: t.project_id,
      project_name: t.project_name,
      completed_at: t.completed_at,
      is_deleted: false,
      updated_at: nowIso,
    }));

    const { error: upsertError } = await admin
      .from(TODOIST_COMPLETED_TASKS)
      .upsert(rows, { onConflict: "user_id,todoist_event_key" });
    if (upsertError) {
      throw new Error(`failed to upsert ${TODOIST_COMPLETED_TASKS}: ${upsertError.message}`);
    }
  }

  // 対象日に紐づく既存行のうち、今回取得した完了イベント集合に含まれないものは
  // Todoist 側で完了が取り消されたとみなしてソフトデリートする。
  const keepIds = new Set(fetched.map((t) => t.todoist_event_key));
  await softDeleteMissing({
    table: TODOIST_COMPLETED_TASKS,
    externalIdCol: "todoist_event_key",
    userId,
    targetDate,
    keepIds,
  });
}
