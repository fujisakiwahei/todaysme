// =============================================================================
// 日記用 Markdown 生成 (Issue #206)
//
//   /daily/[date] のコピーボタンから呼ばれ、表示中の SummaryResponse を
//   Obsidian の Daily ノートに貼り付ける前提のデータブロックへ変換する。
//   UI から分離した純関数にして、フォーマット仕様 (Issue #206) を 1 箇所に
//   閉じ込める。
//
//   フォーマット仕様の要点:
//     - `###` 見出しスタイル。末尾は `---` + 空行で終わり、貼り付け直後に
//       そのまま日記本文を書き始められる。
//     - 冒頭のみ `## 睡眠とアクティブな時間` の H2 見出し。
//     - 未連携サービス (todays_me.* が null) はセクションごと省略。
//     - 連携済みだが 0 件のセクションは見出しを出して `- なし`。
//     - 除外設定されたカレンダー予定 (is_excluded) は含めない。
//     - 進行中の Toggl エントリ (end_at: null) は `HH:MM–（進行中）` 表記。
//     - 時刻はすべて summary.timezone の HH:MM、時間量は `XhYYm`。
// =============================================================================
import type { SummaryResponse } from "~~/shared/schemas";

import { circledNumber } from "./circledNumber";
import { calculateMeAggregate } from "./meAggregate";

function formatHourMinute(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

// 分 → `XhYYm` (例: 405 → "6h45m", 62 → "1h02m")
function formatDurationMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${String(m).padStart(2, "0")}m`;
}

function minutesBetween(startIso: string, endIso: string): number {
  return Math.max(
    0,
    Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000)
  );
}

// -----------------------------------------------------------------------------
// 睡眠ヘッダー行
//   `23:45 就寝 → 06:30 起床（睡眠 6h45m・ベッド 7h02m）`
//   睡眠記録が複数ある日 (二度寝・仮眠等) は行を分けて列挙し、
//   「起床①」「起床②」のラベルで区別する。
// -----------------------------------------------------------------------------
function buildSleepLines(summary: SummaryResponse): string[] {
  if (summary.todays_me.oura === null) return [];

  const sorted = [...summary.timeline.sleep].sort(
    (a, b) => new Date(a.wake_at).getTime() - new Date(b.wake_at).getTime()
  );

  return sorted.map((s, index) => {
    const bedtime = formatHourMinute(s.sleep_start_at, summary.timezone);
    const wake = formatHourMinute(s.wake_at, summary.timezone);
    const wakeLabel = sorted.length > 1 ? `起床${circledNumber(index)}` : "起床";

    // 睡眠 = Oura の実睡眠時間 (null の場合あり)、ベッド = 就寝〜起床の長さ。
    const parts: string[] = [];
    if (s.sleep_minutes != null) {
      parts.push(`睡眠 ${formatDurationMinutes(s.sleep_minutes)}`);
    }
    parts.push(`ベッド ${formatDurationMinutes(minutesBetween(s.sleep_start_at, s.wake_at))}`);

    return `${bedtime} 就寝 → ${wake} ${wakeLabel}（${parts.join("・")}）`;
  });
}

// -----------------------------------------------------------------------------
// 集計行 (覚醒時間 / アクティブ / 未記録)
//   wake 記録がない日 (wake_range が null) はこの行を省略する。
// -----------------------------------------------------------------------------
function buildAggregateLine(summary: SummaryResponse): string | null {
  const aggregate = calculateMeAggregate(summary);
  if (!aggregate) return null;

  return [
    `覚醒時間 ${formatDurationMinutes(aggregate.awakeMin)}`,
    `アクティブ ${formatDurationMinutes(aggregate.activeMin)}`,
    `未記録 ${formatDurationMinutes(aggregate.unrecordedMin)}`,
  ].join(" ｜ ");
}

// 見出し + 箇条書きのセクション。items が空なら `- なし` を出す。
function buildSection(heading: string, items: string[]): string {
  const body = items.length > 0 ? items.map((line) => `- ${line}`).join("\n") : "- なし";
  return `### ${heading}\n\n${body}`;
}

function buildCalendarItems(summary: SummaryResponse): string[] {
  return summary.timeline.calendar
    .filter((ev) => !ev.is_excluded)
    .map((ev) => {
      const start = formatHourMinute(ev.start_at, summary.timezone);
      const end = formatHourMinute(ev.end_at, summary.timezone);
      const title = ev.title || "（無題の予定）";
      return `${start}–${end} ${title}`;
    });
}

function buildTodoistItems(summary: SummaryResponse): string[] {
  const todoist = summary.todays_me.todoist;
  if (todoist === null) return [];
  return todoist.completed.map((t) => t.content || "（無題のタスク）");
}

function buildTogglItems(summary: SummaryResponse): string[] {
  return summary.timeline.toggl.map((t) => {
    const start = formatHourMinute(t.start_at, summary.timezone);
    const label = t.title || t.project_name || "（無題）";
    if (t.end_at == null) {
      // 進行中エントリは終了時刻・時間量を出さない。
      return `${start}–（進行中） ${label}`;
    }
    const end = formatHourMinute(t.end_at, summary.timezone);
    const duration = formatDurationMinutes(minutesBetween(t.start_at, t.end_at));
    return `${start}–${end} ${label}（${duration}）`;
  });
}

function buildFreeTimeNoteItems(summary: SummaryResponse): string[] {
  return [...summary.free_time_notes]
    .sort((a, b) => new Date(a.gap_start_at).getTime() - new Date(b.gap_start_at).getTime())
    .map((note) => {
      const start = formatHourMinute(note.gap_start_at, summary.timezone);
      const end = formatHourMinute(note.gap_end_at, summary.timezone);
      const duration = formatDurationMinutes(minutesBetween(note.gap_start_at, note.gap_end_at));
      const content = note.content.split("\n").join("\n  ");
      return `${start}–${end}（${duration}） ${content}`;
    });
}

export function buildDiaryMarkdown(summary: SummaryResponse): string {
  const blocks: string[] = [];

  // 睡眠ヘッダー + 集計行 (両方あるときは 1 ブロックにまとめる)
  const headerLines = buildSleepLines(summary);
  const aggregateLine = buildAggregateLine(summary);
  if (aggregateLine) headerLines.push(aggregateLine);
  if (headerLines.length > 0) {
    blocks.push(`## 睡眠とアクティブな時間\n\n${headerLines.join("\n")}`);
  }

  if (summary.todays_me.google !== null) {
    blocks.push(buildSection("予定", buildCalendarItems(summary)));
  }
  if (summary.todays_me.todoist !== null) {
    blocks.push(buildSection("完了タスク", buildTodoistItems(summary)));
  }
  if (summary.todays_me.toggl !== null) {
    blocks.push(buildSection("時間の使い方", buildTogglItems(summary)));
  }
  if (summary.free_time_notes.length > 0) {
    blocks.push(buildSection("空き時間", buildFreeTimeNoteItems(summary)));
  }

  // 末尾は `---` + 空行。貼り付け直後にそのまま日記を書き始められるようにする。
  return `${blocks.join("\n\n")}\n\n---\n\n`;
}
