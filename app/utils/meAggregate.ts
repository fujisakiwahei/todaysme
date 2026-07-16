import type { SummaryResponse } from "~~/shared/schemas";

export interface MeAggregate {
  awakeMin: number;
  activeMin: number;
  unrecordedMin: number;
  activeRatio: number;
}

interface TimeInterval {
  start: number;
  end: number;
}

function clampInterval(
  startIso: string,
  endIso: string,
  rangeStart: number,
  rangeEnd: number
): TimeInterval | null {
  const start = Math.max(new Date(startIso).getTime(), rangeStart);
  const end = Math.min(new Date(endIso).getTime(), rangeEnd);
  if (end <= start) return null;
  return { start, end };
}

function mergeIntervals(intervals: TimeInterval[]): TimeInterval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: TimeInterval[] = [];

  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.start > previous.end) {
      merged.push({ ...interval });
      continue;
    }
    previous.end = Math.max(previous.end, interval.end);
  }

  return merged;
}

function durationOutsideSleep(
  startIso: string,
  endIso: string | null,
  rangeStart: number,
  rangeEnd: number,
  sleepIntervals: TimeInterval[]
): number {
  const interval = clampInterval(
    startIso,
    endIso ?? new Date(rangeEnd).toISOString(),
    rangeStart,
    rangeEnd
  );
  if (!interval) return 0;

  let sleepOverlapMs = 0;
  for (const sleep of sleepIntervals) {
    if (sleep.end <= interval.start) continue;
    if (sleep.start >= interval.end) break;
    sleepOverlapMs += Math.max(
      0,
      Math.min(interval.end, sleep.end) - Math.max(interval.start, sleep.start)
    );
  }

  return Math.max(0, interval.end - interval.start - sleepOverlapMs);
}

// 最初の起床から wake range 終端までのうち、同範囲内の二度寝・仮眠を
// 差し引いた時間を「覚醒時間」とする。起床につながる最初の睡眠は wake_at が
// rangeStart と一致するため、clamp 後に長さ 0 となり自動的に除外される。
export function calculateMeAggregate(summary: SummaryResponse): MeAggregate | null {
  if (!summary.wake_range) return null;

  const rangeStart = new Date(summary.wake_range.start).getTime();
  const rangeEnd = new Date(summary.wake_range.end).getTime();
  const rangeMs = Math.max(0, rangeEnd - rangeStart);

  const sleepIntervals = mergeIntervals(
    summary.timeline.sleep
      .map((sleep) => clampInterval(sleep.sleep_start_at, sleep.wake_at, rangeStart, rangeEnd))
      .filter((interval): interval is TimeInterval => interval !== null)
  );
  const sleepMs = sleepIntervals.reduce(
    (total, interval) => total + interval.end - interval.start,
    0
  );
  const awakeMin = Math.max(0, Math.round((rangeMs - sleepMs) / 60000));

  // Calendar と Toggl の重複は従来どおり合算する表示用近似値だが、
  // 睡眠区間と重なる部分は「アクティブ」として扱わない。
  let activeMs = 0;
  for (const event of summary.timeline.calendar) {
    if (event.is_excluded) continue;
    activeMs += durationOutsideSleep(
      event.start_at,
      event.end_at,
      rangeStart,
      rangeEnd,
      sleepIntervals
    );
  }
  for (const entry of summary.timeline.toggl) {
    activeMs += durationOutsideSleep(
      entry.start_at,
      entry.end_at,
      rangeStart,
      rangeEnd,
      sleepIntervals
    );
  }

  const activeMin = Math.min(awakeMin, Math.round(activeMs / 60000));
  const unrecordedMin = Math.max(0, awakeMin - activeMin);
  const activeRatio = awakeMin > 0 ? Math.round((activeMin / awakeMin) * 100) : 0;

  return { awakeMin, activeMin, unrecordedMin, activeRatio };
}
