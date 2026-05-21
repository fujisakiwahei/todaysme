// =============================================================================
// wakeBasedToday
// SPEC §2 / §5 / Issue #116
//
//   「ユーザーにとっての今日」を最新の起床 (oura_sleep_records.wake_at) を起点に
//   組み立てるためのクライアント側ユーティリティ。
//
//   - 日が回っても、まだ次の睡眠が記録されていなければ前回起床日を「今日」とする。
//   - 起床記録が無い (Oura 未連携 / 初回 sync 前など) 場合はカレンダー日付に fallback。
//   - server/utils/wakeRange.ts の targetDateOf と同じロジックを、
//     ブラウザ側でも使えるよう小さく再実装している。
// =============================================================================
import type { SupabaseClient } from "@supabase/supabase-js";

export function targetDateInTimezone(date: Date, timezone: string): string {
  // `Intl.DateTimeFormat("en-CA").format()` の出力は ICU データ依存で必ずしも
  // ISO (YYYY-MM-DD) を保証しない。formatToParts から year/month/day を取り出し
  // 自前で組み立てて挙動差を回避する (server/utils/wakeRange.ts と同じ方針)。
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const yyyy = parts.find((p) => p.type === "year")?.value;
  const mm = parts.find((p) => p.type === "month")?.value;
  const dd = parts.find((p) => p.type === "day")?.value;
  if (!yyyy || !mm || !dd) {
    throw new Error(`Failed to format date in timezone ${timezone}`);
  }
  return `${yyyy}-${mm}-${dd}`;
}

export async function fetchWakeBasedToday(
  client: SupabaseClient,
  userId: string,
  timezone: string,
): Promise<string> {
  // 最新の起床記録の target_date を「今日」とする。
  // 直近 1 件だけ読めば十分 (より古い記録は判定に使わない)。
  const { data, error } = await client
    .from("oura_sleep_records")
    .select("wake_at")
    .eq("user_id", userId)
    .eq("is_deleted", false)
    .order("wake_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ wake_at: string }>();
  if (error) throw error;
  if (!data) {
    // 睡眠記録ゼロ (Oura 未連携 / 初回 sync 前) はカレンダー日付に fallback する。
    return targetDateInTimezone(new Date(), timezone);
  }
  return targetDateInTimezone(new Date(data.wake_at), timezone);
}
