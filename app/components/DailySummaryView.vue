<script setup lang="ts">
// =============================================================================
// DailySummaryView
// SPEC §4 / §5 / §10 / Issue #31
//
//   /daily/[date] と /demo/daily/[date] の共通描画コンポーネント。
//   data fetching と refresh の責務は親ページが持ち、当コンポーネントは
//   渡された summary を Today's ME と Wake-based Timeline / 詳細
//   アコーディオン / sync ステータスの形にレンダリングするのみ。
//
//   - topbar-action スロットで「更新」ボタン等の右上アクションを差し込む。
//   - basePath プロパティで前後日ナビの遷移先を切り替える (/daily か /demo/daily)。
//   - NOW ライン用の now タイマーは「target_date が当日 (= summary.timezone での今日)」
//     のときのみ意味があり、コンポーネント側で 1 分単位に更新する。
// =============================================================================
import type {
  CalendarTimelineEntry,
  SleepTimelineEntry,
  SummaryResponse,
  TogglTimelineEntry,
} from "~~/shared/schemas";
import {
  fetchWakeBasedToday,
  targetDateInTimezone,
} from "~/utils/wakeBasedToday";
import ouraIcon from "~/assets/styles/images/oura.webp";
import googleCalendarIcon from "~/assets/styles/images/google-calendar.webp";
import togglIcon from "~/assets/styles/images/toggl-track.webp";

const props = withDefaults(
  defineProps<{
    summary: SummaryResponse | null;
    loading: boolean;
    errorMessage: string | null;
    dateParam: string;
    basePath?: string;
  }>(),
  {
    basePath: "/daily",
  },
);

const now = ref(new Date());
let nowTimer: ReturnType<typeof setInterval> | null = null;

// =============================================================================
// Date utilities
// =============================================================================
function shiftDate(base: string, days: number): string {
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const prevDate = computed(() => shiftDate(props.dateParam, -1));
const nextDate = computed(() => shiftDate(props.dateParam, 1));

const dateLabel = computed(() => {
  const [y, m, d] = props.dateParam.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][dt.getUTCDay()];
  return `${props.dateParam}（${weekday}）`;
});

function isTodayInTimezone(date: string, timezone: string): boolean {
  // ロケール依存の format(...) (例: "en-CA" でも実装によっては M/D/YYYY) を避け、
  // formatToParts から year/month/day を取り出して自前で YYYY-MM-DD を組み立てる。
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const yyyy = parts.find((p) => p.type === "year")?.value;
  const mm = parts.find((p) => p.type === "month")?.value;
  const dd = parts.find((p) => p.type === "day")?.value;
  if (!yyyy || !mm || !dd) return false;
  return `${yyyy}-${mm}-${dd}` === date;
}

const isToday = computed(() => {
  if (!props.summary) return false;
  return isTodayInTimezone(props.summary.target_date, props.summary.timezone);
});

const timezone = computed(() => props.summary?.timezone ?? "Asia/Tokyo");

// =============================================================================
// Formatters
// =============================================================================
function formatMinutes(min: number | null | undefined): {
  hours: number;
  minutes: number;
} | null {
  if (min == null) return null;
  return { hours: Math.floor(min / 60), minutes: min % 60 };
}

function formatHourMinute(iso: string | null, tz: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function formatDuration(start: string, end: string | null): string {
  const s = new Date(start).getTime();
  // 進行中 (end_at = null) は表示中の日付の wake range 終端で clamp する。
  // 当日: wake_range.end = 現在時刻、過去日: その日の次回睡眠時刻となるため、
  // タイムラインバー側 (barStyle) の clamp と一致し、過去日の duration が
  // 現在時刻まで伸び続ける問題を避けられる。
  const fallbackEnd = timelineSpan.value?.end ?? Date.now();
  const e = end == null ? fallbackEnd : new Date(end).getTime();
  const min = Math.max(0, Math.round((e - s) / 60000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

const lastSyncedAt = computed<string | null>(() => {
  if (!props.summary) return null;
  const ms = props.summary.sync_statuses
    .map((s) => s.last_synced_at)
    .filter((t): t is string => !!t)
    .map((t) => new Date(t).getTime());
  if (ms.length === 0) return null;
  return new Date(Math.max(...ms)).toISOString();
});

// =============================================================================
// Today's ME aggregate (起床経過 / アクティブ / 未記録)
//   - 起床経過 = wake_range の長さ
//   - アクティブ = calendar + work の wake range overlap 合計
//     (重複は union ではなく合算。SPEC §4.1 の表示用近似値)
//   - 未記録   = 起床経過 - アクティブ (下限 0)
// =============================================================================
const meAggregate = computed(() => {
  if (!props.summary?.wake_range) return null;
  const rs = new Date(props.summary.wake_range.start).getTime();
  const re = new Date(props.summary.wake_range.end).getTime();
  const elapsedMin = Math.max(0, Math.round((re - rs) / 60000));

  const overlapMs = (start: string, end: string | null) => {
    const s = Math.max(new Date(start).getTime(), rs);
    const eMs = end == null ? re : new Date(end).getTime();
    const e = Math.min(eMs, re);
    return Math.max(0, e - s);
  };

  let activeMs = 0;
  for (const ev of props.summary.timeline.calendar) {
    // 除外設定 (Issue #108) されたカレンダーは稼働時間に含めない。
    if (ev.is_excluded) continue;
    activeMs += overlapMs(ev.start_at, ev.end_at);
  }
  for (const t of props.summary.timeline.toggl) {
    activeMs += overlapMs(t.start_at, t.end_at);
  }
  const activeMin = Math.min(elapsedMin, Math.round(activeMs / 60000));
  const unrecordedMin = Math.max(0, elapsedMin - activeMin);
  const activeRatio =
    elapsedMin > 0 ? Math.round((activeMin / elapsedMin) * 100) : 0;
  return { elapsedMin, activeMin, unrecordedMin, activeRatio };
});

// =============================================================================
// Timeline geometry
// =============================================================================
const timelineSpan = computed(() => {
  if (!props.summary?.wake_range) return null;
  const start = new Date(props.summary.wake_range.start).getTime();
  const end = new Date(props.summary.wake_range.end).getTime();
  return { start, end, span: Math.max(1, end - start) };
});

// PC は横方向 (left/width)、SP は縦方向 (top/height) に同じ %値を流用するため、
// CSS カスタムプロパティ (--tl-pos / --tl-len) に詰めて返し、向きはスタイル側で
// 切り替える (Issue #128)。
function barStyle(start: string, end: string | null) {
  if (!timelineSpan.value) return { "--tl-pos": "0%", "--tl-len": "0%" };
  const { start: s, end: e, span } = timelineSpan.value;
  const sMs = new Date(start).getTime();
  const eMs = end == null ? e : new Date(end).getTime();
  const clampedStart = Math.max(sMs, s);
  const clampedEnd = Math.min(eMs, e);
  const left = ((clampedStart - s) / span) * 100;
  const width = Math.max(0, ((clampedEnd - clampedStart) / span) * 100);
  return { "--tl-pos": `${left}%`, "--tl-len": `${width}%` };
}

// 軸目盛: 経過時間が長いほど間隔を広げる
const axisTicks = computed(() => {
  if (!timelineSpan.value) return [];
  const spanH = timelineSpan.value.span / 3600000;
  const stepH = spanH > 16 ? 4 : spanH > 8 ? 2 : 1;
  const ticks: { left: number; label: string }[] = [];
  for (let h = 0; h <= spanH; h += stepH) {
    ticks.push({
      left: Math.min(100, (h / spanH) * 100),
      label: `${h}h`,
    });
  }
  return ticks;
});

const nowLineStyle = computed(() => {
  if (!timelineSpan.value || !isToday.value) return null;
  const { start, span } = timelineSpan.value;
  const left = ((now.value.getTime() - start) / span) * 100;
  if (left < 0 || left > 100) return null;
  // barStyle と同じく、向きは CSS 側で切り替える (Issue #128)。
  return { "--tl-pos": `${left}%` };
});

// =============================================================================
// Timeline lane data
// =============================================================================
// 前夜の睡眠 (= wake_at が wake range 開始) は通常バーでは描けないので、
// メタ情報として Sleep レーンに表示する。
const preWakeSleep = computed<SleepTimelineEntry | null>(() => {
  if (!props.summary?.wake_range) return null;
  const rangeStart = new Date(props.summary.wake_range.start).getTime();
  return (
    props.summary.timeline.sleep.find(
      (s) => Math.abs(new Date(s.wake_at).getTime() - rangeStart) < 60_000,
    ) ?? null
  );
});

// レンジ内に収まる (= バー描画可能な) 睡眠記録 (仮眠など)
const inRangeSleep = computed<SleepTimelineEntry[]>(() => {
  if (!props.summary) return [];
  const pre = preWakeSleep.value;
  return props.summary.timeline.sleep.filter((s) => s.id !== pre?.id);
});

const calendarEvents = computed<CalendarTimelineEntry[]>(
  () => props.summary?.timeline.calendar ?? [],
);
const togglEntries = computed<TogglTimelineEntry[]>(
  () => props.summary?.timeline.toggl ?? [],
);

// =============================================================================
// Free-time hover (Issue #110)
//   タイムラインの空き領域にホバーすると、その空き範囲全体 (= 直前のイベント
//   終了から次のイベント開始まで) の最大値を表示する。カーソル位置に依存しない
//   ので、同じ空き帯のどこにホバーしても同じ値が出る。
//   "前 / 次" の判定は Sleep / Calendar / Work の 3 レーンを跨いで行う
//   (例: 同じ Work レーン内では空きでも、別レーンで MTG が走っていれば
//   その MTG で空きが区切られる)。
// =============================================================================
type LaneKey = "sleep" | "calendar" | "work";

interface TimelineEventLite {
  start: number;
  end: number;
  lane: LaneKey;
  title: string;
}

const laneLabels: Record<LaneKey, string> = {
  sleep: "Sleep",
  calendar: "Calendar",
  work: "Work",
};

const allTimelineEvents = computed<TimelineEventLite[]>(() => {
  if (!props.summary) return [];
  const fallbackEnd = timelineSpan.value?.end ?? Date.now();
  const items: TimelineEventLite[] = [];
  for (const s of props.summary.timeline.sleep) {
    items.push({
      start: new Date(s.sleep_start_at).getTime(),
      end: new Date(s.wake_at).getTime(),
      lane: "sleep",
      title: "仮眠",
    });
  }
  for (const ev of props.summary.timeline.calendar) {
    items.push({
      start: new Date(ev.start_at).getTime(),
      end: new Date(ev.end_at).getTime(),
      lane: "calendar",
      title: ev.title || ev.calendar_name || "(無題)",
    });
  }
  for (const t of props.summary.timeline.toggl) {
    items.push({
      start: new Date(t.start_at).getTime(),
      end: t.end_at ? new Date(t.end_at).getTime() : fallbackEnd,
      lane: "work",
      title: t.title || "(タイトル無し)",
    });
  }
  return items.sort((a, b) => a.start - b.start);
});

interface FreeHoverInfo {
  lane: LaneKey;
  leftPct: number;
  widthPct: number;
  rangeStart: number;
  rangeEnd: number;
  prevLane: LaneKey | null;
  prevTitle: string | null;
  nextLane: LaneKey | null;
  nextTitle: string | null;
  gapMinutes: number;
}

const freeHover = ref<FreeHoverInfo | null>(null);

function onTrackMouseMove(e: MouseEvent, lane: LaneKey) {
  if (!timelineSpan.value) return;
  const target = e.target as HTMLElement | null;
  // 既存のバー上では空き時間ではないので非表示にする。
  if (target && target.closest(".tl-bar")) {
    if (freeHover.value?.lane === lane) freeHover.value = null;
    return;
  }
  const trackEl = e.currentTarget as HTMLElement;
  const rect = trackEl.getBoundingClientRect();
  if (rect.width <= 0) return;
  const offsetX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  const ratio = offsetX / rect.width;
  const { start, end, span } = timelineSpan.value;
  const cursorTime = start + ratio * span;

  // 全レーンを横断してカーソル時刻を含む空き範囲の境界を求める:
  //   prev = ev.end <= cursorTime のうち end が最も遅いイベント (= 空き開始)
  //   next = ev.start >  cursorTime のうち start が最も早いイベント (= 空き終了)
  // また、別レーンも含めて cursorTime がいずれかのバー内側にある場合は、
  // 「いま走っている予定がある = 空きではない」のでオーバーレイを出さない。
  let prev: TimelineEventLite | null = null;
  let next: TimelineEventLite | null = null;
  for (const ev of allTimelineEvents.value) {
    if (ev.start <= cursorTime && cursorTime < ev.end) {
      if (freeHover.value?.lane === lane) freeHover.value = null;
      return;
    }
    if (ev.end <= cursorTime) {
      if (!prev || ev.end > prev.end) prev = ev;
    } else if (ev.start > cursorTime) {
      if (!next || ev.start < next.start) next = ev;
    }
  }
  const rangeStart = prev ? prev.end : start;
  const rangeEnd = next ? next.start : end;
  const gapMs = Math.max(0, rangeEnd - rangeStart);
  const gapMinutes = Math.round(gapMs / 60000);
  if (gapMinutes < 1) {
    if (freeHover.value?.lane === lane) freeHover.value = null;
    return;
  }
  const leftPct = ((rangeStart - start) / span) * 100;
  const widthPct = (gapMs / span) * 100;

  freeHover.value = {
    lane,
    leftPct,
    widthPct,
    rangeStart,
    rangeEnd,
    prevLane: prev?.lane ?? null,
    prevTitle: prev?.title ?? null,
    nextLane: next?.lane ?? null,
    nextTitle: next?.title ?? null,
    gapMinutes,
  };
}

function onTrackMouseLeave(lane: LaneKey) {
  if (freeHover.value?.lane === lane) freeHover.value = null;
}

// 日付ナビなどで summary が差し替わったタイミングでオーバーレイ状態を残さない。
// マウスがタイムライン上にとどまったまま別日へ遷移すると、新しい timelineSpan
// に対して古い rangeStart / rangeEnd で再描画されてしまうため (Codex review)。
watch(
  () => props.summary,
  () => {
    freeHover.value = null;
  },
);

function formatGap(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

// Accordion 開閉状態
const openAccordions = reactive<{
  sleep: boolean;
  calendar: boolean;
  work: boolean;
}>({
  sleep: true,
  calendar: true,
  work: true,
});

// =============================================================================
// Today button
// =============================================================================
// 「今日」は純粋なカレンダー日付ではなく、最新の起床 (wake_at) を起点に決まる
// 起床日 (= SPEC の target_date)。日が回ってもまだ寝ていなければ前回起床日を
// 指す (Issue #116)。
//
// 起床日の取得は client mount 後に supabase 経由で行うため、初期描画時は
// カレンダー日付に fallback する (海外移動などレアケースを除き両者は一致する)。
// /demo/daily は認証無し & デモデータなので wake-based 解決はスキップする。
const supabase = useSupabaseClient();
const supabaseUser = useSupabaseUser();
const wakeBasedToday = ref<string | null>(null);

async function refreshWakeBasedToday() {
  if (props.basePath !== "/daily") return;
  const userId = supabaseUser.value?.sub;
  if (!userId) return;
  const tz = props.summary?.timezone ?? "Asia/Tokyo";
  try {
    wakeBasedToday.value = await fetchWakeBasedToday(supabase, userId, tz);
  } catch {
    // 取得失敗時はカレンダー fallback を維持する (UI を壊さない)。
  }
}

const todayDate = computed(() => {
  if (wakeBasedToday.value) return wakeBasedToday.value;
  // summary 未ロード時は Asia/Tokyo を仮置きする。実 timezone と差が出るのは
  // 海外移動時など限定的で、wake-based 解決が走り次第上書きされる。
  const tz = props.summary?.timezone ?? "Asia/Tokyo";
  return targetDateInTimezone(new Date(), tz);
});

const isOnToday = computed(() => props.dateParam === todayDate.value);

// =============================================================================
// Timeline tooltip (hover on desktop / tap on mobile)
// =============================================================================
// "<lane>-<id>" 形式で 1 件だけアクティブにする。SP のタップ操作:
//   - バーをタップ → そのバーをアクティブに
//   - 他のバーをタップ → アクティブを入れ替え
//   - バー以外をタップ → 閉じる
const activeTooltipId = ref<string | null>(null);

function toggleTooltip(id: string, e: MouseEvent) {
  // バー外タップで閉じる document リスナに食わせないため伝播を止める。
  e.stopPropagation();
  activeTooltipId.value = activeTooltipId.value === id ? null : id;
}

function closeTooltip() {
  activeTooltipId.value = null;
}

// =============================================================================
// Lifecycle
// =============================================================================
onMounted(() => {
  // NOW ラインを 1 分単位で動かす (当日のみ意味がある)。
  nowTimer = setInterval(() => {
    now.value = new Date();
  }, 60_000);
  document.addEventListener("click", closeTooltip);
  void refreshWakeBasedToday();
});

// summary が後から到着するケース (timezone が確定する) と、日付ナビで
// 別ページから戻ってきたケースの両方で再取得する。
watch(
  () => [props.summary?.timezone, props.dateParam] as const,
  () => {
    void refreshWakeBasedToday();
  },
);

onBeforeUnmount(() => {
  if (nowTimer != null) clearInterval(nowTimer);
  if (typeof document !== "undefined") {
    document.removeEventListener("click", closeTooltip);
  }
});
</script>

<template>
  <main class="daily">
    <div class="daily__container">
      <header class="daily__topbar">
        <div class="daily__title-block">
          <h1 class="daily__title">Today's ME</h1>
          <p class="daily__subtitle">
            <span v-if="summary?.wake_range" class="daily__subtitle-line">
              起床 {{ formatHourMinute(summary.wake_range.start, timezone) }}
              <template v-if="!isToday">
                〜 {{ formatHourMinute(summary.wake_range.end, timezone) }}
              </template>
            </span>
            <span v-else>Wake-based Timeline は前回起床時刻が必要です</span>
          </p>
        </div>

        <div class="daily__nav-group">
          <NuxtLink
            :to="`${basePath}/${todayDate}`"
            class="daily__today-btn"
            :class="{ 'daily__today-btn--active': isOnToday }"
            :aria-disabled="isOnToday || undefined"
            :tabindex="isOnToday ? -1 : undefined"
          >
            Today
          </NuxtLink>
          <nav class="daily__date-nav" aria-label="日付ナビゲーション">
            <NuxtLink
              :to="`${basePath}/${prevDate}`"
              class="daily__date-btn"
              aria-label="前日"
            >
              ‹
            </NuxtLink>
            <div class="daily__date-current">{{ dateLabel }}</div>
            <NuxtLink
              :to="`${basePath}/${nextDate}`"
              class="daily__date-btn"
              aria-label="翌日"
            >
              ›
            </NuxtLink>
          </nav>
        </div>

        <div class="daily__refresh">
          <slot name="topbar-action" />
          <span v-if="lastSyncedAt" class="daily__refresh-time">
            最終同期 {{ formatHourMinute(lastSyncedAt, timezone) }}
          </span>
        </div>
      </header>

      <p v-if="errorMessage" class="daily__error">{{ errorMessage }}</p>

      <section v-if="loading && !summary" class="daily__loading">
        読み込み中...
      </section>

      <template v-else-if="summary">
        <!-- Metric cards -->
        <section class="metrics-grid">
          <!-- Sleep / Oura -->
          <article
            class="metric metric--sleep"
            :data-state="summary.todays_me.oura == null ? 'disconnected' : ''"
          >
            <header class="metric__head">
              <span class="metric__head-l">
                <img
                  :src="ouraIcon"
                  alt=""
                  class="metric__icon metric__icon--img"
                  aria-hidden="true"
                />
                Sleep
              </span>
              <span class="metric__tag">Oura</span>
            </header>
            <template v-if="summary.todays_me.oura">
              <div class="metric__value">
                <template
                  v-if="formatMinutes(summary.todays_me.oura.sleep_minutes)"
                >
                  {{ formatMinutes(summary.todays_me.oura.sleep_minutes)!.hours
                  }}<span class="unit">h</span
                  >{{
                    String(
                      formatMinutes(summary.todays_me.oura.sleep_minutes)!
                        .minutes,
                    ).padStart(2, "0")
                  }}<span class="unit">m</span>
                </template>
                <template v-else>—</template>
              </div>
              <dl class="metric__sub">
                <div>
                  <dt>起床</dt>
                  <dd>
                    {{
                      formatHourMinute(summary.todays_me.oura.wake_at, timezone)
                    }}
                  </dd>
                </div>
              </dl>
            </template>
            <p v-else class="metric__placeholder">
              <NuxtLink to="/settings">Oura と接続する →</NuxtLink>
            </p>
          </article>

          <!-- Calendar / Google -->
          <article
            class="metric metric--calendar"
            :data-state="summary.todays_me.google == null ? 'disconnected' : ''"
          >
            <header class="metric__head">
              <span class="metric__head-l">
                <img
                  :src="googleCalendarIcon"
                  alt=""
                  class="metric__icon metric__icon--img"
                  aria-hidden="true"
                />
                Calendar
              </span>
              <span class="metric__tag">Google</span>
            </header>
            <template v-if="summary.todays_me.google">
              <div class="metric__value">
                {{ formatMinutes(summary.todays_me.google.total_minutes)!.hours
                }}<span class="unit">h</span
                >{{
                  String(
                    formatMinutes(summary.todays_me.google.total_minutes)!
                      .minutes,
                  ).padStart(2, "0")
                }}<span class="unit">m</span>
              </div>
              <dl class="metric__sub">
                <div
                  v-for="item in summary.todays_me.google.by_calendar"
                  :key="item.calendar_name"
                >
                  <dt>{{ item.calendar_name || "（未分類）" }}</dt>
                  <dd>
                    {{ formatMinutes(item.minutes)?.hours }}h
                    {{
                      String(
                        formatMinutes(item.minutes)?.minutes ?? 0,
                      ).padStart(2, "0")
                    }}m
                  </dd>
                </div>
              </dl>
            </template>
            <p v-else class="metric__placeholder">
              <NuxtLink to="/settings">Google と接続する →</NuxtLink>
            </p>
          </article>

          <!-- Work / Toggl -->
          <article
            class="metric metric--work"
            :data-state="summary.todays_me.toggl == null ? 'disconnected' : ''"
          >
            <header class="metric__head">
              <span class="metric__head-l">
                <img
                  :src="togglIcon"
                  alt=""
                  class="metric__icon metric__icon--img"
                  aria-hidden="true"
                />
                Work
              </span>
              <span class="metric__tag">Toggl</span>
            </header>
            <template v-if="summary.todays_me.toggl">
              <div class="metric__value">
                {{ formatMinutes(summary.todays_me.toggl.total_minutes)!.hours
                }}<span class="unit">h</span
                >{{
                  String(
                    formatMinutes(summary.todays_me.toggl.total_minutes)!
                      .minutes,
                  ).padStart(2, "0")
                }}<span class="unit">m</span>
              </div>
              <dl class="metric__sub">
                <div
                  v-for="item in summary.todays_me.toggl.by_title"
                  :key="`${item.title}|${item.project_name ?? ''}`"
                >
                  <dt>
                    {{ item.title || "（タイトル無し）" }}
                    <span v-if="item.project_name" class="metric__sub-project">
                      {{ item.project_name }}
                    </span>
                  </dt>
                  <dd>
                    {{ formatMinutes(item.minutes)?.hours }}h
                    {{
                      String(
                        formatMinutes(item.minutes)?.minutes ?? 0,
                      ).padStart(2, "0")
                    }}m
                  </dd>
                </div>
              </dl>
            </template>
            <p v-else class="metric__placeholder">
              <NuxtLink to="/settings">Toggl と接続する →</NuxtLink>
            </p>
          </article>

          <!-- Today's ME (wide) -->
          <article v-if="meAggregate" class="metric metric--me">
            <header class="metric__head">
              <span class="metric__head-l">
                <span class="metric__icon" aria-hidden="true">Σ</span>
                Today's ME
              </span>
            </header>
            <div class="metric--me__row">
              <div class="metric--me__value">
                <div class="metric__value">
                  {{ formatMinutes(meAggregate.elapsedMin)!.hours
                  }}<span class="unit">h</span
                  >{{
                    String(
                      formatMinutes(meAggregate.elapsedMin)!.minutes,
                    ).padStart(2, "0")
                  }}<span class="unit">m</span>
                </div>
                <p class="metric--me__caption">起床経過</p>
              </div>
              <dl class="metric--me__list">
                <div>
                  <dt>アクティブ</dt>
                  <dd>
                    <b>{{ meAggregate.activeRatio }}%</b>
                    <span>
                      ({{ formatMinutes(meAggregate.activeMin)?.hours }}h
                      {{
                        String(
                          formatMinutes(meAggregate.activeMin)?.minutes ?? 0,
                        ).padStart(2, "0")
                      }}m)
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>未記録</dt>
                  <dd>
                    <b class="warn">
                      {{ formatMinutes(meAggregate.unrecordedMin)?.hours }}h
                      {{
                        String(
                          formatMinutes(meAggregate.unrecordedMin)?.minutes ??
                            0,
                        ).padStart(2, "0")
                      }}m
                    </b>
                  </dd>
                </div>
              </dl>
            </div>
          </article>
        </section>

        <!-- Wake-based Timeline -->
        <section class="timeline">
          <header class="timeline__head">
            <h2 class="timeline__title">Wake-based Timeline</h2>
            <p v-if="timelineSpan" class="timeline__caption">
              起床
              {{ formatHourMinute(summary.wake_range!.start, timezone) }}
              を 0h として、
              <template v-if="isToday">現在 (NOW)</template>
              <template v-else>
                {{ formatHourMinute(summary.wake_range!.end, timezone) }}
              </template>
              までを表示
            </p>
          </header>

          <div v-if="!timelineSpan" class="timeline__empty">
            この日の起床記録がまだありません。Oura の同期後に表示されます。
          </div>

          <div v-else class="timeline__body">
            <!-- axis -->
            <div class="tl-axis">
              <span
                v-for="tick in axisTicks"
                :key="tick.label"
                class="tl-axis__tick"
                :style="{ '--tl-pos': `${tick.left}%` }"
                :data-origin="tick.left === 0 || undefined"
              >
                {{ tick.label }}
              </span>
              <div
                v-if="nowLineStyle"
                class="tl-now"
                :style="nowLineStyle"
                aria-label="現在時刻"
              >
                <span class="tl-now__label">
                  NOW {{ formatHourMinute(now.toISOString(), timezone) }}
                </span>
              </div>
            </div>

            <!-- Sleep lane -->
            <div class="tl-row tl-row--sleep">
              <div class="tl-row__label">Sleep</div>
              <div
                class="tl-row__track"
                @mousemove="onTrackMouseMove($event, 'sleep')"
                @mouseleave="onTrackMouseLeave('sleep')"
              >
                <div
                  v-if="freeHover && freeHover.lane === 'sleep'"
                  class="tl-free"
                  :style="{
                    '--tl-pos': `${freeHover.leftPct}%`,
                    '--tl-len': `${freeHover.widthPct}%`,
                  }"
                  aria-hidden="true"
                >
                  <span class="tl-free__tooltip" role="tooltip">
                    <span class="tl-free__tooltip-title">
                      空き {{ formatGap(freeHover.gapMinutes) }}
                    </span>
                    <span class="tl-free__tooltip-time">
                      {{
                        formatHourMinute(
                          new Date(freeHover.rangeStart).toISOString(),
                          timezone,
                        )
                      }}
                      →
                      {{
                        formatHourMinute(
                          new Date(freeHover.rangeEnd).toISOString(),
                          timezone,
                        )
                      }}
                    </span>
                    <span
                      v-if="freeHover.nextTitle && freeHover.nextLane"
                      class="tl-free__tooltip-next"
                    >
                      次:
                      <span
                        class="tl-free__tooltip-lane"
                        :data-lane="freeHover.nextLane"
                      >
                        {{ laneLabels[freeHover.nextLane] }}
                      </span>
                      {{ freeHover.nextTitle }}
                    </span>
                  </span>
                </div>
                <span v-if="preWakeSleep" class="tl-row__meta">
                  就寝
                  {{ formatHourMinute(preWakeSleep.sleep_start_at, timezone) }}
                  → 起床
                  {{ formatHourMinute(preWakeSleep.wake_at, timezone) }} ·
                  {{
                    formatDuration(
                      preWakeSleep.sleep_start_at,
                      preWakeSleep.wake_at,
                    )
                  }}
                </span>
                <div
                  v-for="s in inRangeSleep"
                  :key="s.id"
                  class="tl-bar tl-bar--sleep"
                  :class="{
                    'tl-bar--active': activeTooltipId === `sleep-${s.id}`,
                  }"
                  :style="barStyle(s.sleep_start_at, s.wake_at)"
                  :aria-label="`仮眠 ${formatHourMinute(s.sleep_start_at, timezone)} - ${formatHourMinute(s.wake_at, timezone)}`"
                  @click="toggleTooltip(`sleep-${s.id}`, $event)"
                >
                  <span class="tl-bar__text">仮眠</span>
                  <span
                    class="tl-bar__tooltip"
                    role="tooltip"
                    aria-hidden="true"
                  >
                    <span class="tl-bar__tooltip-title">仮眠</span>
                    <span class="tl-bar__tooltip-time">
                      {{ formatHourMinute(s.sleep_start_at, timezone) }} –
                      {{ formatHourMinute(s.wake_at, timezone) }}
                    </span>
                  </span>
                </div>
              </div>
            </div>

            <!-- Calendar lane -->
            <div class="tl-row tl-row--calendar">
              <div class="tl-row__label">Calendar</div>
              <div
                class="tl-row__track"
                @mousemove="onTrackMouseMove($event, 'calendar')"
                @mouseleave="onTrackMouseLeave('calendar')"
              >
                <div
                  v-if="freeHover && freeHover.lane === 'calendar'"
                  class="tl-free"
                  :style="{
                    '--tl-pos': `${freeHover.leftPct}%`,
                    '--tl-len': `${freeHover.widthPct}%`,
                  }"
                  aria-hidden="true"
                >
                  <span class="tl-free__tooltip" role="tooltip">
                    <span class="tl-free__tooltip-title">
                      空き {{ formatGap(freeHover.gapMinutes) }}
                    </span>
                    <span class="tl-free__tooltip-time">
                      {{
                        formatHourMinute(
                          new Date(freeHover.rangeStart).toISOString(),
                          timezone,
                        )
                      }}
                      →
                      {{
                        formatHourMinute(
                          new Date(freeHover.rangeEnd).toISOString(),
                          timezone,
                        )
                      }}
                    </span>
                    <span
                      v-if="freeHover.nextTitle && freeHover.nextLane"
                      class="tl-free__tooltip-next"
                    >
                      次:
                      <span
                        class="tl-free__tooltip-lane"
                        :data-lane="freeHover.nextLane"
                      >
                        {{ laneLabels[freeHover.nextLane] }}
                      </span>
                      {{ freeHover.nextTitle }}
                    </span>
                  </span>
                </div>
                <span v-if="calendarEvents.length === 0" class="tl-row__empty">
                  予定なし
                </span>
                <div
                  v-for="ev in calendarEvents"
                  :key="ev.id"
                  class="tl-bar tl-bar--calendar"
                  :class="{
                    'tl-bar--active': activeTooltipId === `calendar-${ev.id}`,
                    'tl-bar--excluded': ev.is_excluded,
                  }"
                  :style="barStyle(ev.start_at, ev.end_at)"
                  :aria-label="`${ev.title || ev.calendar_name || '(無題)'}${ev.is_excluded ? '（稼働時間から除外）' : ''} ${formatHourMinute(ev.start_at, timezone)} - ${formatHourMinute(ev.end_at, timezone)}`"
                  @click="toggleTooltip(`calendar-${ev.id}`, $event)"
                >
                  <span class="tl-bar__text">
                    {{ ev.title || ev.calendar_name || "(無題)" }}
                  </span>
                  <span
                    class="tl-bar__tooltip"
                    role="tooltip"
                    aria-hidden="true"
                  >
                    <span class="tl-bar__tooltip-title">
                      {{ ev.title || ev.calendar_name || "(無題)" }}
                    </span>
                    <span class="tl-bar__tooltip-time">
                      {{ formatHourMinute(ev.start_at, timezone) }} –
                      {{ formatHourMinute(ev.end_at, timezone) }}
                    </span>
                  </span>
                </div>
              </div>
            </div>

            <!-- Work lane -->
            <div class="tl-row tl-row--work">
              <div class="tl-row__label">Work</div>
              <div
                class="tl-row__track"
                @mousemove="onTrackMouseMove($event, 'work')"
                @mouseleave="onTrackMouseLeave('work')"
              >
                <div
                  v-if="freeHover && freeHover.lane === 'work'"
                  class="tl-free"
                  :style="{
                    '--tl-pos': `${freeHover.leftPct}%`,
                    '--tl-len': `${freeHover.widthPct}%`,
                  }"
                  aria-hidden="true"
                >
                  <span class="tl-free__tooltip" role="tooltip">
                    <span class="tl-free__tooltip-title">
                      空き {{ formatGap(freeHover.gapMinutes) }}
                    </span>
                    <span class="tl-free__tooltip-time">
                      {{
                        formatHourMinute(
                          new Date(freeHover.rangeStart).toISOString(),
                          timezone,
                        )
                      }}
                      →
                      {{
                        formatHourMinute(
                          new Date(freeHover.rangeEnd).toISOString(),
                          timezone,
                        )
                      }}
                    </span>
                    <span
                      v-if="freeHover.nextTitle && freeHover.nextLane"
                      class="tl-free__tooltip-next"
                    >
                      次:
                      <span
                        class="tl-free__tooltip-lane"
                        :data-lane="freeHover.nextLane"
                      >
                        {{ laneLabels[freeHover.nextLane] }}
                      </span>
                      {{ freeHover.nextTitle }}
                    </span>
                  </span>
                </div>
                <span v-if="togglEntries.length === 0" class="tl-row__empty">
                  作業ログなし
                </span>
                <div
                  v-for="t in togglEntries"
                  :key="t.id"
                  class="tl-bar tl-bar--work"
                  :class="{
                    'tl-bar--active': activeTooltipId === `work-${t.id}`,
                  }"
                  :style="barStyle(t.start_at, t.end_at)"
                  :aria-label="`${t.title || '(タイトル無し)'}${t.project_name ? ` (${t.project_name})` : ''} ${formatHourMinute(t.start_at, timezone)} - ${t.end_at ? formatHourMinute(t.end_at, timezone) : '進行中'}`"
                  @click="toggleTooltip(`work-${t.id}`, $event)"
                >
                  <span class="tl-bar__text">
                    {{ t.title || "(タイトル無し)" }}
                  </span>
                  <span v-if="t.end_at == null" class="tl-bar__live">●</span>
                  <span
                    class="tl-bar__tooltip"
                    role="tooltip"
                    aria-hidden="true"
                  >
                    <span class="tl-bar__tooltip-title">
                      {{ t.title || "(タイトル無し)" }}
                    </span>
                    <span v-if="t.project_name" class="tl-bar__tooltip-project">
                      {{ t.project_name }}
                    </span>
                    <span class="tl-bar__tooltip-time">
                      {{ formatHourMinute(t.start_at, timezone) }} –
                      {{
                        t.end_at
                          ? formatHourMinute(t.end_at, timezone)
                          : "進行中"
                      }}
                    </span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- Detail accordions -->
        <section class="details">
          <h2 class="details__title">詳細</h2>

          <article class="acc acc--sleep">
            <button
              type="button"
              class="acc__head"
              :aria-expanded="openAccordions.sleep"
              @click="openAccordions.sleep = !openAccordions.sleep"
            >
              <img
                :src="ouraIcon"
                alt=""
                class="acc__icon acc__icon--img"
                aria-hidden="true"
              />
              <span class="acc__title">Sleep — Oura</span>
              <span class="acc__meta">
                {{ summary.timeline.sleep.length }} records
              </span>
              <span class="acc__chev" aria-hidden="true">
                {{ openAccordions.sleep ? "▾" : "▸" }}
              </span>
            </button>
            <div v-if="openAccordions.sleep" class="acc__body">
              <p v-if="summary.timeline.sleep.length === 0" class="acc__empty">
                睡眠データはありません。
              </p>
              <ul v-else class="entry-list">
                <li
                  v-for="s in summary.timeline.sleep"
                  :key="s.id"
                  class="entry"
                >
                  <span class="entry__time">
                    {{ formatHourMinute(s.sleep_start_at, timezone) }} —
                    {{ formatHourMinute(s.wake_at, timezone) }}
                  </span>
                  <span class="entry__title">睡眠</span>
                  <span class="entry__dur">
                    {{ formatDuration(s.sleep_start_at, s.wake_at) }}
                  </span>
                </li>
              </ul>
            </div>
          </article>

          <article class="acc acc--calendar">
            <button
              type="button"
              class="acc__head"
              :aria-expanded="openAccordions.calendar"
              @click="openAccordions.calendar = !openAccordions.calendar"
            >
              <img
                :src="googleCalendarIcon"
                alt=""
                class="acc__icon acc__icon--img"
                aria-hidden="true"
              />
              <span class="acc__title">Calendar — Google</span>
              <span class="acc__meta">
                {{ summary.timeline.calendar.length }} events
              </span>
              <span class="acc__chev" aria-hidden="true">
                {{ openAccordions.calendar ? "▾" : "▸" }}
              </span>
            </button>
            <div v-if="openAccordions.calendar" class="acc__body">
              <p
                v-if="summary.timeline.calendar.length === 0"
                class="acc__empty"
              >
                予定はありません。
              </p>
              <ul v-else class="entry-list">
                <li
                  v-for="ev in summary.timeline.calendar"
                  :key="ev.id"
                  class="entry"
                  :class="{ 'entry--excluded': ev.is_excluded }"
                >
                  <span class="entry__time">
                    {{ formatHourMinute(ev.start_at, timezone) }} —
                    {{ formatHourMinute(ev.end_at, timezone) }}
                  </span>
                  <span class="entry__title">
                    {{ ev.title || "(無題)" }}
                    <span v-if="ev.calendar_name" class="entry__tag">
                      {{ ev.calendar_name }}
                    </span>
                    <span v-if="ev.is_excluded" class="entry__excluded-tag">
                      除外
                    </span>
                  </span>
                  <span class="entry__dur">
                    {{ formatDuration(ev.start_at, ev.end_at) }}
                  </span>
                </li>
              </ul>
            </div>
          </article>

          <article class="acc acc--work">
            <button
              type="button"
              class="acc__head"
              :aria-expanded="openAccordions.work"
              @click="openAccordions.work = !openAccordions.work"
            >
              <img
                :src="togglIcon"
                alt=""
                class="acc__icon acc__icon--img"
                aria-hidden="true"
              />
              <span class="acc__title">Work — Toggl</span>
              <span class="acc__meta">
                {{ summary.timeline.toggl.length }} entries
              </span>
              <span class="acc__chev" aria-hidden="true">
                {{ openAccordions.work ? "▾" : "▸" }}
              </span>
            </button>
            <div v-if="openAccordions.work" class="acc__body">
              <p v-if="summary.timeline.toggl.length === 0" class="acc__empty">
                作業ログはありません。
              </p>
              <ul v-else class="entry-list">
                <li
                  v-for="t in summary.timeline.toggl"
                  :key="t.id"
                  class="entry"
                >
                  <span class="entry__time">
                    {{ formatHourMinute(t.start_at, timezone) }} —
                    {{
                      t.end_at ? formatHourMinute(t.end_at, timezone) : "進行中"
                    }}
                  </span>
                  <span class="entry__title">
                    {{ t.title || "(タイトル無し)" }}
                    <span v-if="t.project_name" class="entry__tag">
                      {{ t.project_name }}
                    </span>
                  </span>
                  <span class="entry__dur">
                    {{ formatDuration(t.start_at, t.end_at) }}
                  </span>
                </li>
              </ul>
            </div>
          </article>
        </section>

        <!-- Sync status -->
        <section v-if="summary.sync_statuses.length > 0" class="sync">
          <h2 class="sync__title">同期ステータス</h2>
          <ul class="sync__list">
            <li
              v-for="s in summary.sync_statuses"
              :key="s.source"
              class="sync__item"
              :data-status="s.status"
            >
              <span class="sync__source">{{ s.source }}</span>
              <span class="sync__status">{{ s.status }}</span>
              <span class="sync__time">
                {{ formatHourMinute(s.last_synced_at, timezone) }}
              </span>
              <span v-if="s.error_message" class="sync__error">
                {{ s.error_message }}
              </span>
            </li>
          </ul>
        </section>
      </template>
    </div>
  </main>
</template>

<style lang="scss" scoped>
$color-bg: #fafaf7;
$color-surface: #f2f0ea;
$color-border: #e2dfd6;
$color-border-2: #edebe4;
$color-text: #1a1814;
$color-text-muted: #6b6960;
$color-text-dim: #9aa0a6;
$color-accent: #f6dc7a;
$color-accent-hover: #ecce5c;
$color-sleep: #3b4f86;
$color-sleep-bg: #eaeef6;
$color-calendar: #3e7b5a;
$color-calendar-bg: #e5efe8;
$color-work: #c2683a;
$color-work-bg: #f5e7db;
$color-warning: #b7791f;
$color-error: #c53030;
$color-error-bg: #fbe9e9;
$font-mono: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;
$font-en:
  "Geist",
  "Inter",
  system-ui,
  -apple-system,
  sans-serif;

.daily {
  padding: 32px 24px 96px;
  min-height: 100vh;
  min-height: 100dvh;
  font-family: "Geist", "Noto Sans JP", "Hiragino Sans", sans-serif;
  color: $color-text;
  background: $color-bg;

  @media (max-width: 640px) {
    padding: 20px 16px 64px;
  }
}

.daily__container {
  margin: 0 auto;
  max-width: 1200px;
}

.daily__topbar {
  margin-bottom: 32px;
  display: grid;
  align-items: center;
  gap: 16px;
  grid-template-columns: 1fr auto auto;

  @media (max-width: 880px) {
    gap: 12px;
    grid-template-columns: 1fr;
  }
}

.daily__title-block {
  min-width: 0;
}

.daily__title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;

  @media (max-width: 640px) {
    font-size: 22px;
  }
}

.daily__subtitle {
  margin-top: 4px;
  font-family: $font-mono;
  font-size: 13px;
  color: $color-text-muted;
}

.daily__subtitle-line {
  font-variant-numeric: tabular-nums;
}

.daily__nav-group {
  display: inline-flex;
  align-items: center;
  gap: 8px;

  @media (max-width: 880px) {
    justify-self: start;
  }
}

.daily__today-btn {
  padding: 0 14px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  font-family: $font-en;
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  color: $color-text;
  background: #fff;
  border: 1px solid $color-border;
  border-radius: 999px;
  box-shadow: 0 1px 2px rgba(26, 24, 20, 0.04);
  transition:
    background 0.15s,
    color 0.15s;

  &:hover {
    background: $color-surface;
  }

  &--active {
    color: $color-text-dim;
    background: $color-surface;
    cursor: default;
    pointer-events: none;
  }

  @media (max-width: 380px) {
    padding: 0 10px;
    font-size: 12px;
  }
}

.daily__date-nav {
  padding: 4px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #fff;
  border: 1px solid $color-border;
  border-radius: 999px;
  box-shadow: 0 1px 2px rgba(26, 24, 20, 0.04);
}

.daily__date-btn {
  margin-bottom: 4px;
  width: 32px;
  height: 32px;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  font-size: 20px;
  // `‹` `›` (U+2039 / U+203A) は line-height 内でベースライン寄りに描画され、
  // 通常の line-height だと視覚的に下に寄って見える。0 にしてグリフ自体を
  // ボタンの上下中央に揃える。
  line-height: 0;
  text-decoration: none;
  color: $color-text-muted;
  transition: color 0.15s;

  &:hover {
    color: $color-text;
  }
}

.daily__date-current {
  padding: 0 14px;
  min-width: 160px;
  font-family: $font-en;
  font-size: 14px;
  font-weight: 600;
  text-align: center;
  font-variant-numeric: tabular-nums;

  @media (max-width: 380px) {
    padding: 0 6px;
    min-width: 0;
    font-size: 13px;
  }
}

.daily__refresh {
  display: inline-flex;
  align-items: center;
  gap: 10px;

  @media (max-width: 880px) {
    justify-self: start;
  }
}

.daily__refresh-time {
  font-family: $font-mono;
  font-size: 11px;
  color: $color-text-muted;
}

.daily__error {
  margin-bottom: 24px;
  padding: 12px 16px;
  font-size: 13px;
  color: $color-error;
  background: $color-error-bg;
  border: 1px solid $color-error;
  border-radius: 8px;
}

.daily__loading {
  padding: 48px;
  text-align: center;
  color: $color-text-muted;
}

// -----------------------------------------------------------
// Metric grid
// -----------------------------------------------------------
.metrics-grid {
  margin-bottom: 40px;
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(3, 1fr);

  @media (max-width: 880px) {
    grid-template-columns: 1fr 1fr;
  }
  @media (max-width: 560px) {
    grid-template-columns: 1fr;
  }
}

.metric {
  padding: 20px 22px;
  min-height: 148px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: #fff;
  border: 1px solid $color-border;
  border-radius: 16px;

  &[data-state="disconnected"] {
    color: $color-text-muted;
    background: $color-surface;
  }
}

.metric--me {
  grid-column: 1 / -1;
  background: linear-gradient(135deg, #fff 0%, $color-surface 100%);
}

.metric--me__row {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 32px;
}

.metric--me__value {
  min-width: 200px;
  flex: 1 1 auto;
}

.metric--me__caption {
  margin-top: 4px;
  font-size: 12px;
  color: $color-text-muted;
}

.metric--me__list {
  padding-left: 24px;
  display: flex;
  flex: 0 0 280px;
  flex-direction: column;
  border-left: 1px solid $color-border-2;

  > div {
    padding: 10px 0;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    border-top: 1px dashed $color-border-2;

    &:first-child {
      border-top: none;
    }
  }

  dt {
    font-size: 12px;
    color: $color-text-muted;
  }

  dd {
    font-family: $font-en;
    font-variant-numeric: tabular-nums;
    font-size: 14px;
    font-weight: 600;

    b {
      margin-right: 4px;
      font-size: 16px;
    }

    span {
      font-size: 12px;
      font-weight: 500;
      color: $color-text-muted;
    }

    .warn {
      color: $color-warning;
    }
  }

  @media (max-width: 640px) {
    padding-top: 12px;
    padding-left: 0;
    flex: 1 1 100%;
    border-top: 1px solid $color-border-2;
    border-left: none;
  }
}

.metric__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: $color-text-muted;
}

.metric__head-l {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}

.metric__icon {
  width: 26px;
  height: 26px;
  display: grid;
  font-size: 12px;
  font-weight: 700;
  border-radius: 8px;
  place-items: center;

  .metric--sleep & {
    color: $color-sleep;
    background: $color-sleep-bg;
  }
  .metric--calendar & {
    color: $color-calendar;
    background: $color-calendar-bg;
  }
  .metric--work & {
    color: $color-work;
    background: $color-work-bg;
  }
  .metric--me & {
    color: #111827;
    background: #f1f3f6;
  }
}

.metric__icon--img {
  padding: 2px;
  object-fit: contain;
  background: #fff;
  border: 1px solid $color-border-2;
}

.metric__tag {
  font-family: $font-mono;
  font-size: 11px;
  color: $color-text-muted;
}

.metric__value {
  margin-top: 4px;
  display: flex;
  align-items: baseline;
  gap: 2px;
  font-family: $font-en;
  font-size: 40px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: -0.025em;
  font-variant-numeric: tabular-nums;

  .unit {
    margin-right: 8px;
    margin-left: 2px;
    font-size: 16px;
    font-weight: 500;
    color: $color-text-muted;

    &:last-child {
      margin-right: 0;
    }
  }
}

.metric--me .metric__value {
  font-size: 48px;
}

.metric__sub {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: $color-text-muted;

  > div {
    padding: 6px 0;
    display: flex;
    justify-content: space-between;
    border-top: 1px dashed $color-border-2;

    &:first-child {
      border-top: none;
    }
  }

  dt {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  dd {
    margin-left: 8px;
    font-family: $font-en;
    font-size: 13px;
    font-weight: 600;
    color: $color-text;
    font-variant-numeric: tabular-nums;
  }
}

// Issue #112: Today's ME の Work `by_title` 内に紐づくプロジェクト名を
// 小さなピル風で表示する。タイトルが省略される場合でも見えるよう
// inline-block 扱いでタイトルの右に並べる。
.metric__sub-project {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
  color: $color-text-muted;
  background: $color-surface;
  border: 1px solid $color-border;
  border-radius: 999px;
  vertical-align: 1px;
}

.metric__placeholder {
  margin-top: auto;
  font-size: 13px;

  a {
    text-decoration: underline;
    color: $color-text;
    text-underline-offset: 3px;

    &:hover {
      color: $color-accent-hover;
    }
  }
}

// -----------------------------------------------------------
// Timeline
// -----------------------------------------------------------
.timeline {
  margin-bottom: 40px;
  padding: 24px;
  background: #fff;
  border: 1px solid $color-border;
  border-radius: 16px;
}

.timeline__head {
  margin-bottom: 16px;
}

.timeline__title {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.timeline__caption {
  margin-top: 4px;
  font-family: $font-mono;
  font-size: 12px;
  color: $color-text-muted;
}

.timeline__empty {
  padding: 24px;
  font-size: 13px;
  text-align: center;
  color: $color-text-muted;
}

.timeline__body {
  position: relative;
}

.tl-axis {
  position: relative;
  margin-left: 84px;
  height: 22px;
  border-bottom: 1px solid $color-border;
}

.tl-axis__tick {
  position: absolute;
  top: 0;
  bottom: -4px;
  left: var(--tl-pos, 0);
  font-family: $font-mono;
  font-size: 10px;
  color: $color-text-muted;
  transform: translateX(-50%);

  &[data-origin] {
    font-weight: 700;
    color: $color-text;
  }
}

.tl-now {
  position: absolute;
  z-index: 2;
  top: -8px;
  bottom: -176px;
  left: var(--tl-pos, 0);
  width: 2px;
  background: #dc2626;
  pointer-events: none;
}

.tl-now__label {
  position: absolute;
  top: -16px;
  left: 4px;
  font-family: $font-mono;
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
  color: #dc2626;
}

.tl-row {
  position: relative;
  height: 56px;
  display: flex;
  align-items: center;
  border-bottom: 1px dashed $color-border-2;

  &:last-child {
    border-bottom: none;
  }
}

.tl-row__label {
  width: 84px;
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 500;

  .tl-row--sleep & {
    color: $color-sleep;
  }
  .tl-row--calendar & {
    color: $color-calendar;
  }
  .tl-row--work & {
    color: $color-work;
  }
}

.tl-row__track {
  position: relative;
  height: 100%;
  flex: 1;

  &::before {
    content: "";
    position: absolute;
    top: 50%;
    right: 0;
    left: 0;
    border-top: 1px dotted $color-border-2;
  }
}

.tl-row__meta {
  position: absolute;
  top: 50%;
  left: 0;
  padding: 4px 10px;
  font-family: $font-mono;
  font-size: 11px;
  color: $color-sleep;
  background: $color-sleep-bg;
  border-radius: 6px;
  transform: translateY(-50%);
}

.tl-row__empty {
  position: absolute;
  top: 50%;
  left: 0;
  font-family: $font-mono;
  font-size: 11px;
  color: $color-text-dim;
  transform: translateY(-50%);
}

.tl-bar {
  position: absolute;
  top: 50%;
  left: var(--tl-pos, 0);
  padding: 0 8px;
  width: var(--tl-len, 0);
  height: 28px;
  display: flex;
  align-items: center;
  font-size: 11px;
  font-weight: 500;
  border-radius: 6px;
  transform: translateY(-50%);
  transition: filter 0.12s;
  // ツールチップを上にはみ出させるため overflow は visible にする。
  // テキストの ellipsis は子要素 .tl-bar__text 側で行う。
  cursor: pointer;

  &:hover,
  &.tl-bar--active {
    z-index: 4;
    filter: brightness(0.97);
  }

  &--sleep {
    color: $color-sleep;
    background: $color-sleep-bg;
    border-left: 3px solid $color-sleep;
  }
  &--calendar {
    color: $color-calendar;
    background: $color-calendar-bg;
    border-left: 3px solid $color-calendar;
  }
  &--work {
    color: $color-work;
    background: $color-work-bg;
    border-left: 3px solid $color-work;
  }

  // Issue #108: 稼働時間集計から除外されたカレンダーは「参考情報」として
  // 視覚的に薄く表示する。タップ/ホバーでツールチップは通常どおり出る。
  &--excluded {
    opacity: 0.4;
    border-left-style: dashed;
  }
}

.tl-bar__text {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tl-bar__live {
  margin-left: 6px;
  flex-shrink: 0;
  color: $color-error;
  animation: blink 1.6s infinite;
}

// ツールチップ: PC はホバー、SP はタップ (.tl-bar--active) で表示。
.tl-bar__tooltip {
  position: absolute;
  z-index: 5;
  bottom: calc(100% + 6px);
  left: 50%;
  padding: 8px 12px;
  // width: max-content + max-width で「内容に応じてフィット、上限あり」を実現する。
  // min-width / shrink-to-fit に任せると、狭い親に対して 1 文字ずつ縦に折り返す
  // 挙動になることがあるため、明示的に max-content にしてしまう。
  width: max-content;
  max-width: min(260px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-family: $font-en;
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  white-space: normal;
  color: #fff;
  background: rgba(26, 24, 20, 0.94);
  border-radius: 8px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
  opacity: 0;
  transform: translate(-50%, 4px);
  transition:
    opacity 0.12s,
    transform 0.12s;
  pointer-events: none;

  // 矢印
  &::after {
    content: "";
    position: absolute;
    top: 100%;
    left: 50%;
    border: 5px solid transparent;
    border-top-color: rgba(26, 24, 20, 0.94);
    transform: translateX(-50%);
  }

  .tl-bar:hover &,
  .tl-bar--active & {
    opacity: 1;
    transform: translate(-50%, 0);
  }

  // SP では bar の幅が狭くなりがちなので、bar 左寄せにして
  // 画面右端ギリギリまで使えるようにする。
  @media (max-width: 640px) {
    left: 0;
    max-width: calc(100vw - 32px);
    transform: translate(0, 4px);

    &::after {
      left: 20px;
    }

    .tl-bar:hover &,
    .tl-bar--active & {
      transform: translate(0, 0);
    }
  }
}

.tl-bar__tooltip-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}

.tl-bar__tooltip-time {
  font-family: $font-mono;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.78);
  font-variant-numeric: tabular-nums;
}

// Issue #112: Toggl の Work バーのツールチップ内に表示するプロジェクト名。
// タイトル直下に小さなピル風で出す。
.tl-bar__tooltip-project {
  align-self: flex-start;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.2;
  color: rgba(255, 255, 255, 0.92);
  background: rgba(255, 255, 255, 0.16);
  border-radius: 999px;
}

// -----------------------------------------------------------
// Free-time hover overlay (Issue #110)
// -----------------------------------------------------------
.tl-free {
  position: absolute;
  top: 50%;
  left: var(--tl-pos, 0);
  width: var(--tl-len, 0);
  height: 28px;
  // overlay は track 上に描くがバーよりは下に置く (z-index 0)。
  // ツールチップ側で z-index を上げる。
  background: repeating-linear-gradient(
    135deg,
    rgba(26, 24, 20, 0.06) 0,
    rgba(26, 24, 20, 0.06) 6px,
    rgba(26, 24, 20, 0) 6px,
    rgba(26, 24, 20, 0) 12px
  );
  border-right: 1px dashed rgba(26, 24, 20, 0.45);
  border-left: 1px dashed rgba(26, 24, 20, 0.45);
  border-radius: 4px;
  transform: translateY(-50%);
  pointer-events: none;
}

.tl-free__tooltip {
  position: absolute;
  z-index: 6;
  bottom: calc(100% + 6px);
  left: 0;
  padding: 8px 12px;
  width: max-content;
  max-width: min(260px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-family: $font-en;
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  color: #fff;
  background: rgba(26, 24, 20, 0.94);
  border-radius: 8px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);

  &::after {
    content: "";
    position: absolute;
    top: 100%;
    left: 14px;
    border: 5px solid transparent;
    border-top-color: rgba(26, 24, 20, 0.94);
  }
}

.tl-free__tooltip-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}

.tl-free__tooltip-time {
  font-family: $font-mono;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.78);
  font-variant-numeric: tabular-nums;
}

.tl-free__tooltip-next {
  font-size: 11px;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.82);
}

.tl-free__tooltip-lane {
  margin-right: 4px;
  padding: 1px 6px;
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  background: rgba(255, 255, 255, 0.18);
  border-radius: 4px;

  &[data-lane="sleep"] {
    background: rgba(120, 145, 200, 0.55);
  }
  &[data-lane="calendar"] {
    background: rgba(120, 175, 140, 0.55);
  }
  &[data-lane="work"] {
    background: rgba(200, 130, 80, 0.55);
  }
}

// -----------------------------------------------------------
// Timeline — SP vertical layout (Issue #128)
//   PC では横軸 (起床 = 左, NOW = 右) のタイムラインだが、SP では幅が足りず
//   バーが潰れて読めなくなるため、同じ %値を縦軸 (起床 = 上, NOW = 下) に
//   読み替えて 3 レーンを縦カラムに並べる。
//   レイアウトの幾何だけを切り替え、空き時間ホバー等のロジック側は触らない。
// -----------------------------------------------------------
@media (max-width: 640px) {
  .timeline__body {
    position: relative;
    min-height: 520px;
    display: grid;
    column-gap: 4px;
    grid-template-columns: 36px repeat(3, minmax(0, 1fr));
    grid-template-rows: 28px 1fr;
  }

  // 軸は track 領域 (label の下) に全幅で敷き、目盛りと NOW ライン用の
  // 相対基準にする。トラック側より z-index を下げて背景扱いにする。
  .tl-axis {
    z-index: 0;
    margin-left: 0;
    width: 100%;
    height: 100%;
    grid-column: 1 / -1;
    grid-row: 2;
    border-right: none;
    border-bottom: none;
    pointer-events: none;
  }

  .tl-axis__tick {
    top: var(--tl-pos, 0);
    right: auto;
    bottom: auto;
    left: 0;
    padding-right: 4px;
    width: 36px;
    text-align: right;
    transform: translateY(-50%);
  }

  .tl-now {
    z-index: 3;
    top: var(--tl-pos, 0);
    right: 0;
    bottom: auto;
    left: 0;
    width: 100%;
    height: 2px;
  }

  .tl-now__label {
    top: -14px;
    left: 0;
    padding-right: 4px;
    width: 36px;
    text-align: right;
  }

  // 各レーン (Sleep / Calendar / Work) を縦カラムに。
  .tl-row {
    position: relative;
    z-index: 1;
    height: auto;
    flex-direction: column;
    align-items: stretch;
    border-bottom: none;
  }

  .tl-row--sleep {
    grid-column: 2;
    grid-row: 1 / -1;
  }
  .tl-row--calendar {
    grid-column: 3;
    grid-row: 1 / -1;
  }
  .tl-row--work {
    grid-column: 4;
    grid-row: 1 / -1;
  }

  .tl-row__label {
    width: 100%;
    height: 28px;
    display: flex;
    flex-shrink: 0;
    justify-content: center;
    align-items: center;
    text-align: center;
    border-bottom: 1px dashed $color-border-2;
  }

  .tl-row__track {
    width: 100%;
    height: auto;
    flex: 1;
  }

  // PC では中央水平の点線。SP では中央垂直の点線に切替。
  .tl-row__track::before {
    top: 0;
    right: auto;
    bottom: 0;
    left: 50%;
    border-top: none;
    border-left: 1px dotted $color-border-2;
  }

  // 前夜の睡眠メタは、Sleep カラムのトラック上部 (= 起床時刻付近) に置く。
  .tl-row__meta {
    top: 4px;
    right: 2px;
    left: 2px;
    padding: 4px 6px;
    font-size: 10px;
    line-height: 1.35;
    text-align: left;
    white-space: normal;
    word-break: break-word;
    transform: none;
  }

  .tl-row__empty {
    top: 12px;
    right: 0;
    left: 0;
    text-align: center;
    transform: none;
  }

  // バーは横軸の left/width ではなく、縦軸の top/height にマッピングする。
  // ツールチップ (.tl-bar__tooltip) はバー外へ絶対配置するため overflow は
  // visible のまま (PC と同じ方針)。バー内テキストの ellipsis は
  // .tl-bar__text 側の line-clamp で行う。
  .tl-bar {
    top: var(--tl-pos, 0);
    right: 2px;
    left: 2px;
    padding: 4px 6px;
    width: auto;
    height: var(--tl-len, 0);
    min-height: 18px;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: stretch;
    transform: none;
  }

  .tl-bar__text {
    // 高さに応じて自動で 1〜2 行に収まるように。
    display: -webkit-box;
    flex: 0 0 auto;
    overflow: hidden;
    line-height: 1.25;
    white-space: normal;
    word-break: break-word;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .tl-bar__live {
    margin-top: 4px;
    margin-left: 0;
  }

  // ツールチップはバーの上に出る既存挙動でほぼそのまま使えるが、
  // 縦バーは左右いっぱいに広がるので、左端基準に揃え直す。
  .tl-bar__tooltip {
    top: 100%;
    bottom: auto;
    left: 0;
    margin-top: 6px;
    transform: translate(0, -4px);

    &::after {
      top: auto;
      bottom: 100%;
      left: 20px;
      border-top-color: transparent;
      border-bottom-color: rgba(26, 24, 20, 0.94);
    }

    .tl-bar:hover &,
    .tl-bar--active & {
      transform: translate(0, 0);
    }
  }

  // 空き時間ホバーオーバーレイも縦に切り替える。
  .tl-free {
    top: var(--tl-pos, 0);
    right: 2px;
    left: 2px;
    width: auto;
    height: var(--tl-len, 0);
    border-top: 1px dashed rgba(26, 24, 20, 0.45);
    border-right: none;
    border-bottom: 1px dashed rgba(26, 24, 20, 0.45);
    border-left: none;
    transform: none;
  }

  .tl-free__tooltip {
    top: 100%;
    bottom: auto;
    left: 0;
    margin-top: 6px;

    &::after {
      top: auto;
      bottom: 100%;
      left: 14px;
      border-top-color: transparent;
      border-bottom-color: rgba(26, 24, 20, 0.94);
    }
  }
}

@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

// -----------------------------------------------------------
// Details accordions
// -----------------------------------------------------------
.details {
  margin-bottom: 32px;
}

.details__title {
  margin-bottom: 16px;
  font-size: 16px;
  font-weight: 600;
}

.acc {
  overflow: hidden;
  background: #fff;
  border: 1px solid $color-border;
  border-radius: 12px;

  & + & {
    margin-top: 10px;
  }
}

.acc__head {
  padding: 14px 18px;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  text-align: left;
  background: none;
  border: none;
  transition: background 0.15s;
  cursor: pointer;

  &:hover {
    background: $color-surface;
  }
}

.acc__icon {
  width: 30px;
  height: 30px;
  display: grid;
  font-size: 12px;
  font-weight: 700;
  border-radius: 8px;
  place-items: center;

  .acc--sleep & {
    color: $color-sleep;
    background: $color-sleep-bg;
  }
  .acc--calendar & {
    color: $color-calendar;
    background: $color-calendar-bg;
  }
  .acc--work & {
    color: $color-work;
    background: $color-work-bg;
  }
}

.acc__icon--img {
  padding: 3px;
  object-fit: contain;
  background: #fff;
  border: 1px solid $color-border-2;
}

.acc__title {
  font-size: 14px;
  font-weight: 600;
}

.acc__meta {
  margin-left: auto;
  font-family: $font-mono;
  font-size: 12px;
  color: $color-text-muted;
}

.acc__chev {
  font-size: 12px;
  color: $color-text-muted;
}

.acc__body {
  padding: 14px 18px 18px;
  border-top: 1px solid $color-border-2;
}

.acc__empty {
  font-size: 13px;
  color: $color-text-muted;
}

.entry-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.entry {
  padding: 10px 0;
  display: grid;
  align-items: center;
  gap: 12px;
  grid-template-columns: 140px 1fr auto;
  font-size: 14px;
  border-bottom: 1px dashed $color-border-2;

  &:last-child {
    border-bottom: none;
  }

  @media (max-width: 560px) {
    gap: 8px;
    grid-template-columns: 1fr auto;
  }
}

.entry__time {
  font-family: $font-mono;
  font-size: 12px;
  color: $color-text-muted;

  @media (max-width: 560px) {
    grid-column: 1 / -1;
    font-size: 11px;
  }
}

.entry__title {
  min-width: 0;
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  font-size: 16px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $color-text;

  // SP では幅が足りずタイトルが省略されて読めなくなるため、
  // ellipsis をやめて折り返し表示にする (長いメールアドレス等も break)。
  @media (max-width: 560px) {
    overflow: visible;
    font-size: 15px;
    text-overflow: clip;
    white-space: normal;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
}

.entry__tag {
  margin-left: 0;
  padding: 3px 10px;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.2;
  color: $color-text-muted;
  background: $color-surface;
  border: 1px solid $color-border;
  border-radius: 999px;

  @media (max-width: 560px) {
    font-size: 13px;
  }
}

// Issue #108: 除外されたカレンダーは詳細一覧でも薄く表示し、
// 「除外」バッジで稼働時間に含まれないことを明示する。
.entry--excluded {
  opacity: 0.55;
}

.entry__excluded-tag {
  padding: 3px 10px;
  font-family: $font-mono;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: 0.04em;
  color: $color-text-muted;
  background: $color-bg;
  border: 1px dashed $color-border;
  border-radius: 999px;

  @media (max-width: 560px) {
    font-size: 10px;
  }
}

.entry__dur {
  font-family: $font-en;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  font-weight: 500;
  color: $color-text-muted;
}

// -----------------------------------------------------------
// Sync status
// -----------------------------------------------------------
.sync {
  margin-top: 24px;
  padding: 16px 20px;
  background: $color-surface;
  border: 1px solid $color-border;
  border-radius: 12px;
}

.sync__title {
  margin-bottom: 10px;
  font-family: $font-mono;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: $color-text-muted;
}

.sync__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sync__item {
  display: grid;
  align-items: baseline;
  gap: 12px;
  grid-template-columns: 80px 100px 80px 1fr;
  font-family: $font-mono;
  font-size: 12px;
  color: $color-text-muted;

  &[data-status="success"] .sync__status {
    color: $color-calendar;
  }
  &[data-status="failed"] .sync__status {
    color: $color-error;
  }
  &[data-status="in_progress"] .sync__status {
    color: $color-warning;
  }

  @media (max-width: 640px) {
    grid-template-columns: 1fr 1fr;
  }
}

.sync__source {
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: $color-text;
}

.sync__error {
  color: $color-error;
}
</style>
