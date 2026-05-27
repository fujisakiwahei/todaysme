// =============================================================================
// soft-deleted な行を物理削除する (Issue #150)
// SPEC §11.3 (ソフトデリート) + 保管期間を過ぎた抜け殻の物理削除
//
//   - 対象テーブル: oura_sleep_records / google_calendar_events / toggl_time_entries。
//     いずれも sync 時に取得できなくなった既存行を `is_deleted = true` にして
//     残しておく設計だが、放置すると無限に積み上がる (特に Notion Calendar 経由で
//     カレンダー間を頻繁に行き来する Google イベント) ため、一定期間経過後の
//     行は物理削除する。
//   - 保管期間 (PURGE_RETENTION_DAYS) は 30 日。当日 sync の競合や「削除を取り消
//     したい」ケースのバッファとして妥当そうな値。
//   - RLS を bypass する必要があるため Supabase admin client から呼ぶ。
//   - 部分失敗を許容 (cron 全体と同じ方針)。テーブル単位で結果を返し、呼び出し
//     側のレスポンス / ログに集計させる。
// =============================================================================
import { getSupabaseAdmin } from "./supabaseAdmin";

const PURGE_RETENTION_DAYS = 30;

export const PURGE_TARGETS = [
  "oura_sleep_records",
  "google_calendar_events",
  "toggl_time_entries",
] as const;

export type PurgeTarget = (typeof PURGE_TARGETS)[number];

export interface PurgeResult {
  table: PurgeTarget;
  deleted: number;
  error: string | null;
}

export async function purgeSoftDeleted(now: Date = new Date()): Promise<PurgeResult[]> {
  const admin = getSupabaseAdmin();
  const cutoffMs = now.getTime() - PURGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const results: PurgeResult[] = [];

  for (const table of PURGE_TARGETS) {
    try {
      const { error, count } = await admin
        .from(table)
        .delete({ count: "exact" })
        .eq("is_deleted", true)
        .lt("updated_at", cutoffIso);

      if (error) {
        // 個別エラー詳細はレスポンスに乗せない (cron 既存方針: 集計のみ返す)
        // ので、運用検知のため Vercel ログに残す。
        console.error(`[purgeSoftDeleted] ${table} failed: ${error.message}`);
        results.push({ table, deleted: 0, error: error.message });
        continue;
      }

      results.push({ table, deleted: count ?? 0, error: null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[purgeSoftDeleted] ${table} threw: ${message}`);
      results.push({ table, deleted: 0, error: message });
    }
  }

  return results;
}
