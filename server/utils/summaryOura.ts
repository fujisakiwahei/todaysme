// =============================================================================
// Today's ME の Oura サマリ集計
//
//   起床日 (= target_date) が対象日と一致する睡眠セッションを起床時刻の昇順に
//   並べ、合算値 (sleep_minutes / time_in_bed_minutes) と内訳 (sessions) を返す。
//   二度寝・仮眠で 1 日に複数セッションがある日は「起床①②…」として UI に出す。
//
//   本番 (/api/summary) とデモ (/api/demo/summary) で同じ集計になるよう、
//   ここに一元化する。
// =============================================================================
import type { TodaysMe } from "../../shared/schemas";

import { targetDateOf } from "./wakeRange";

export interface OuraSummarySleepRow {
  sleep_start_at: string;
  wake_at: string;
  sleep_minutes: number | null;
}

function minutesBetween(startIso: string, endIso: string): number {
  return Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000);
}

export function buildTodaysMeOura(
  sleepRows: OuraSummarySleepRow[],
  targetDate: string,
  timezone: string
): NonNullable<TodaysMe["oura"]> {
  // wake range には前日夜〜当日朝の睡眠も入るので、wake_at が target_date と
  // 一致するものだけが「この日の起床」。wake_at → YYYY-MM-DD への変換は
  // targetDateOf に一元化 (ICU 依存の Intl format() を直接使わない)。
  const sessionsRows = sleepRows
    .filter((r) => targetDateOf(r.wake_at, timezone) === targetDate)
    .sort((a, b) => new Date(a.wake_at).getTime() - new Date(b.wake_at).getTime());

  const sessions = sessionsRows.map((r) => ({
    sleep_start_at: r.sleep_start_at,
    wake_at: r.wake_at,
    sleep_minutes: r.sleep_minutes,
    // 「ベッドにいた時間」= wake_at − sleep_start_at。sleep_minutes は Oura の
    // total_sleep_duration なので、入眠前 / 中途覚醒の時間が落ちる。
    // 両方並べて見せたい (dashboard Oura)。
    time_in_bed_minutes: minutesBetween(r.sleep_start_at, r.wake_at),
  }));

  // sleep_minutes は欠損 (null) がありうるので、非 null のセッションだけ合算する。
  // 全セッションが null (または起床が無い日) は null のまま返す。
  const knownSleepMinutes = sessions
    .map((s) => s.sleep_minutes)
    .filter((m): m is number => m != null);
  const totalSleepMinutes =
    knownSleepMinutes.length > 0 ? knownSleepMinutes.reduce((acc, m) => acc + m, 0) : null;
  const totalTimeInBedMinutes =
    sessions.length > 0 ? sessions.reduce((acc, s) => acc + s.time_in_bed_minutes, 0) : null;

  return {
    sleep_minutes: totalSleepMinutes,
    time_in_bed_minutes: totalTimeInBedMinutes,
    // その日最初の起床 (= wake range の開始)。
    wake_at: sessions[0]?.wake_at ?? null,
    sessions,
  };
}
