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
// computeWakeRange
// 純粋関数版。テスト容易性のため I/O を分離している。
//   - 当日:   その日の wake_at → 現在 (options.now)
//   - 過去日: その日の wake_at → 次の睡眠開始時刻 (なければ 24h 後)
//   - target_date に対応する wake_at がない場合は null
// =============================================================================

export function computeWakeRange(
  targetDate: string,
  sleeps: SleepRecordLike[],
  options: { timezone: string; now?: Date },
): WakeRange | null {
  const now = options.now ?? new Date();
  const sorted = sleeps
    .map((s) => ({
      sleep_start_at: toDate(s.sleep_start_at),
      wake_at: toDate(s.wake_at),
    }))
    .sort((a, b) => a.wake_at.getTime() - b.wake_at.getTime());

  const idx = sorted.findIndex(
    (s) => targetDateOf(s.wake_at, options.timezone) === targetDate,
  );
  if (idx === -1) return null;

  const start = sorted[idx]!.wake_at;
  const todayInTz = targetDateOf(now, options.timezone);
  const isToday = targetDate === todayInTz;

  let end: Date;
  if (isToday) {
    end = now;
  } else {
    const nextSleep = sorted[idx + 1]?.sleep_start_at;
    // 次の睡眠記録が無い場合のフォールバックは 24h 後
    end = nextSleep ?? new Date(start.getTime() + 24 * 60 * 60 * 1000);
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
  options: WakeRangeOfOptions,
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
  end: Date | string | null | undefined,
): boolean {
  const s = toDate(start).getTime();
  const e = end == null ? range.end.getTime() : toDate(end).getTime();
  return s < range.end.getTime() && e > range.start.getTime();
}

// =============================================================================
// computeDayRange (Issue #101)
//   Oura 未連携 / 睡眠未取得で wakeRange が null になったときのフォールバック。
//   `target_date` のユーザータイムゾーンにおける 00:00 〜 24:00 (当日のみ now で clamp)
//   を返す。Toggl / Google を「起床時刻が記録されていなくても表示できる」状態に
//   するための補助レンジで、SPEC §4.2 の Wake-based Timeline そのものは置き換えない。
// =============================================================================

function getTzOffsetMinutes(date: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string): number => {
    const v = parts.find((p) => p.type === type)?.value;
    if (v === undefined) {
      throw new Error(`failed to format ${type} in timezone ${timezone}`);
    }
    return parseInt(v, 10);
  };
  // hour12:false の場合に Intl 実装によっては 24 を返すことがあるため 0 に正規化する。
  const hour = get("hour") % 24;
  const local = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return Math.round((local - date.getTime()) / 60_000);
}

export function computeDayRange(
  targetDate: string,
  timezone: string,
  now?: Date,
): WakeRange {
  // 正午 UTC を基準に TZ オフセットを引いて「targetDate 00:00 in TZ」の UTC instant を求める。
  // DST 切り替え日でも正午基準なら境界に重ならないので安全。
  const utcNoon = new Date(`${targetDate}T12:00:00Z`);
  const offsetMin = getTzOffsetMinutes(utcNoon, timezone);
  const startMs =
    new Date(`${targetDate}T00:00:00Z`).getTime() - offsetMin * 60_000;
  const start = new Date(startMs);
  const dayEndMs = startMs + 24 * 60 * 60 * 1000;
  const nowMs = (now ?? new Date()).getTime();
  // 当日表示は「now まで」、過去/未来日は丸ごと 24h ぶん。
  const end = new Date(Math.min(nowMs, dayEndMs));
  return { start, end };
}
