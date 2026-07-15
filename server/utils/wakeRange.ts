import type { SupabaseClient } from "@supabase/supabase-js";

// =============================================================================
// 型定義
// =============================================================================

export interface WakeRange {
  start: Date;
  end: Date;
}

export interface SleepRecordLike {
  sleep_start_at: Date | string;
  wake_at: Date | string;
}

// =============================================================================
// 内部ヘルパ
// =============================================================================

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid date value: ${String(value)}`);
  }
  return date;
}

// =============================================================================
// targetDateOf
// SPEC §2 / Issue #24:
//   各レコードの target_date は「ユーザータイムゾーンにおける wake_at の日付」
// =============================================================================

export function targetDateOf(wakeAt: Date | string, timezone: string): string {
  const date = toDate(wakeAt);
  // `Intl.DateTimeFormat("en-CA").format()` の出力は ICU データ依存で必ずしも
  // ISO (YYYY-MM-DD) を保証しない (M/D/YYYY を返す実装もある)。
  // formatToParts から year/month/day を取り出して自前で組み立てる。
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

// =============================================================================
// dayBoundsInTimezone
//   YYYY-MM-DD を指定したタイムゾーンの 00:00 / 翌日 00:00 に対応する UTC
//   インスタント (Date) として返す。Issue #201 のように「target_date の
//   1 日分の予定」を抽出するときに使う。
//
//   実装メモ: tz offset を一度だけ計算するため、target_date の正午 UTC を
//   tz でフォーマットしたものとの差分から offset(分) を求めている。DST 跨ぎ
//   の日でも、その日の正午における offset を採用する単純実装で十分。
// =============================================================================

export function dayBoundsInTimezone(
  targetDate: string,
  timezone: string
): { start: Date; end: Date } {
  const [y, m, d] = targetDate.split("-").map(Number);
  if (!y || !m || !d) {
    throw new Error(`Invalid target_date: ${targetDate}`);
  }
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(noonUtc);
  const hh = Number(parts.find((p) => p.type === "hour")?.value);
  const mm = Number(parts.find((p) => p.type === "minute")?.value);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
    throw new Error(`Failed to format noon in timezone ${timezone}`);
  }
  // hh:mm は「12:00 UTC が tz で何時に見えるか」。tz offset(分) = (tz local) - UTC
  const offsetMin = hh * 60 + mm - 12 * 60;
  // 00:00 (local) を UTC 換算: UTC = local 00:00 - offsetMin
  const start = new Date(Date.UTC(y, m - 1, d, 0, -offsetMin, 0));
  const end = new Date(Date.UTC(y, m - 1, d + 1, 0, -offsetMin, 0));
  return { start, end };
}

// =============================================================================
// computeWakeRange
// 純粋関数版。テスト容易性のため I/O を分離している。
//   - 当日:   その日の wake_at → 現在 (options.now)
//   - 過去日: その日の wake_at → 次の睡眠開始時刻
//             (まだ次の睡眠が無ければ「現在も起きている」とみなして現在時刻)
//   - target_date に対応する wake_at がない場合は null
// =============================================================================

export function computeWakeRange(
  targetDate: string,
  sleeps: SleepRecordLike[],
  options: { timezone: string; now?: Date }
): WakeRange | null {
  const now = options.now ?? new Date();
  const sorted = sleeps
    .map((s) => ({
      sleep_start_at: toDate(s.sleep_start_at),
      wake_at: toDate(s.wake_at),
    }))
    .sort((a, b) => a.wake_at.getTime() - b.wake_at.getTime());

  const idx = sorted.findIndex((s) => targetDateOf(s.wake_at, options.timezone) === targetDate);
  if (idx === -1) return null;

  const start = sorted[idx]!.wake_at;
  const todayInTz = targetDateOf(now, options.timezone);
  const isToday = targetDate === todayInTz;

  let end: Date;
  if (isToday) {
    end = now;
  } else {
    const nextSleep = sorted[idx + 1]?.sleep_start_at;
    // 次の睡眠記録が無い場合、ユーザはその起床以降まだ寝ていない =
    // wake range は現在も続いていると扱う (Issue #113)。
    // 「24h 後で頭打ち」だと日跨ぎ直後に起床経過時間が 24h で固定されてしまう。
    // ただし古い日付でデータが欠落しているケースで経過時間が際限なく増えないよう
    // start から 24h を上限としてキャップする。
    end = nextSleep ?? new Date(Math.min(now.getTime(), start.getTime() + 24 * 60 * 60 * 1000));
  }

  return { start, end };
}

// =============================================================================
// wakeRangeOf
// I/O 付きのラッパ。Supabase から target_date 周辺の睡眠記録を取得し、
// computeWakeRange に委譲する。
// =============================================================================

export interface WakeRangeOfOptions {
  client: SupabaseClient;
  timezone: string;
  now?: Date;
}

export async function wakeRangeOf(
  targetDate: string,
  userId: string,
  options: WakeRangeOfOptions
): Promise<WakeRange | null> {
  // targetDate を中心に ±2 日の睡眠記録を読む
  // (前夜の睡眠開始 〜 翌朝の起床 を取りこぼさないため)
  const center = new Date(`${targetDate}T12:00:00Z`).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const from = new Date(center - 2 * dayMs).toISOString();
  const to = new Date(center + 2 * dayMs).toISOString();

  const { data, error } = await options.client
    .from("oura_sleep_records")
    .select("sleep_start_at, wake_at")
    .eq("user_id", userId)
    .eq("is_deleted", false)
    .gte("wake_at", from)
    .lte("wake_at", to);

  if (error) throw error;

  return computeWakeRange(targetDate, (data ?? []) as SleepRecordLike[], {
    timezone: options.timezone,
    now: options.now,
  });
}

// =============================================================================
// overlaps
// wake range と [start, end] の重なりを判定する。
// end が null/undefined の場合 (例: 進行中の Toggl エントリ) は range.end までを範囲とみなす。
// =============================================================================

export function overlaps(
  range: WakeRange,
  start: Date | string,
  end: Date | string | null | undefined
): boolean {
  const s = toDate(start).getTime();
  const e = end == null ? range.end.getTime() : toDate(end).getTime();
  return s < range.end.getTime() && e > range.start.getTime();
}
