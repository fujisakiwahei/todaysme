// =============================================================================
// GET /api/demo/summary?date=YYYY-MM-DD
// SPEC §5 / §11.4 / Issue #31
//
//   - デモ専用テーブル (demo_oura_sleep_records / demo_google_calendar_events /
//     demo_toggl_time_entries) のみを読む。本番テーブルや外部 API は触らない。
//   - 認証不要 (anon でアクセス可能)。
//   - タイムゾーンは Asia/Tokyo 固定。デモには user 概念が無いため
//     users.timezone に頼れない (seed データも JST 想定で作られている)。
//   - 集計ロジック (wake range / overlap / Today's ME) は /api/summary と
//     等価。実装が完全に重複しないよう wake range のヘルパは
//     server/utils/wakeRange.ts の computeWakeRange を再利用する。
//   - sync_statuses は常に空配列。デモは外部 API 同期を行わないため。
//   - レスポンスは summaryResponseSchema で検証してから返す。
// =============================================================================
import {
  summaryRequestSchema,
  summaryResponseSchema,
  type CalendarTimelineEntry,
  type FreeTimeNote,
  type SleepTimelineEntry,
  type SummaryResponse,
  type Timeline,
  type TodaysMe,
  type TogglTimelineEntry,
  type WakeRange,
} from "../../../shared/schemas";
import { buildTodaysMeOura } from "../../utils/summaryOura";
import { getSupabaseAdmin } from "../../utils/supabaseAdmin";
import { parseOrThrow } from "../../utils/validation";
import {
  computeWakeRange,
  dayBoundsInTimezone,
  overlaps,
  type SleepRecordLike,
  type WakeRange as InternalWakeRange,
} from "../../utils/wakeRange";

const DEMO_TIMEZONE = "Asia/Tokyo";

const demoFreeTimeNotes: FreeTimeNote[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    target_date: "2026-05-17",
    gap_start_at: "2026-05-16T23:00:00.000Z",
    gap_end_at: "2026-05-17T00:30:00.000Z",
    content: "朝食をとって、少し散歩",
    created_at: "2026-05-17T00:35:00.000Z",
    updated_at: "2026-05-17T00:35:00.000Z",
  },
];

interface SleepRow {
  id: string;
  sleep_start_at: string;
  wake_at: string;
  sleep_minutes: number | null;
}

interface CalendarRow {
  id: string;
  google_event_id: string;
  calendar_name: string | null;
  title: string | null;
  start_at: string;
  end_at: string;
}

interface TogglRow {
  id: string;
  toggl_entry_id: string;
  title: string | null;
  // Issue #112: Toggl project の id / 名前。デモテーブルにもカラムを追加した。
  project_id: number | null;
  project_name: string | null;
  start_at: string;
  end_at: string | null;
}

// wake range と [start, end] の重なり部分の長さ (ミリ秒)。
// end が null (進行中の Toggl エントリ) のときは range.end までで打ち切る。
function overlappingMs(range: InternalWakeRange, start: string, end: string | null): number {
  const s = Math.max(new Date(start).getTime(), range.start.getTime());
  const eMs = end == null ? range.end.getTime() : new Date(end).getTime();
  const e = Math.min(eMs, range.end.getTime());
  if (e <= s) return 0;
  return e - s;
}

function msToMinutes(ms: number): number {
  return Math.round(ms / 60000);
}

export default defineEventHandler(async (event) => {
  const { date } = parseOrThrow(summaryRequestSchema, getQuery(event));

  const admin = getSupabaseAdmin();
  const timezone = DEMO_TIMEZONE;

  // -- wake range -----------------------------------------------------------
  // targetDate を中心に ±2 日の睡眠記録を読んで pure な computeWakeRange に渡す。
  // (本番の wakeRangeOf は user_id で絞るため流用できない)
  const center = new Date(`${date}T12:00:00Z`).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const fromIsoForWake = new Date(center - 2 * dayMs).toISOString();
  const toIsoForWake = new Date(center + 2 * dayMs).toISOString();

  const { data: wakeSleepRows, error: wakeSleepErr } = await admin
    .from("demo_oura_sleep_records")
    .select("sleep_start_at, wake_at")
    .eq("is_deleted", false)
    .gte("wake_at", fromIsoForWake)
    .lte("wake_at", toIsoForWake);
  if (wakeSleepErr) throw wakeSleepErr;

  const internalRange = computeWakeRange(date, (wakeSleepRows ?? []) as SleepRecordLike[], {
    timezone,
  });

  // Issue #201: 当日の予定一覧用に target_date の 1 日範囲を別途計算する。
  const dayBounds = dayBoundsInTimezone(date, timezone);
  const dayBoundStartIso = dayBounds.start.toISOString();
  const dayBoundEndIso = dayBounds.end.toISOString();

  // -- records (wake range と重なるもの) -----------------------------------
  let sleepRows: SleepRow[] = [];
  let calendarRows: CalendarRow[] = [];
  let calendarRowsForDay: CalendarRow[] = [];
  let togglRows: TogglRow[] = [];

  if (internalRange) {
    const fromIso = internalRange.start.toISOString();
    const toIso = internalRange.end.toISOString();

    // Issue #201: wake range / target_date のいずれかに重なる予定を 1 回で取得。
    const calendarFromIso = fromIso < dayBoundStartIso ? fromIso : dayBoundStartIso;
    const calendarToIso = toIso > dayBoundEndIso ? toIso : dayBoundEndIso;

    const [sleepRes, calendarRes, togglRes] = await Promise.all([
      admin
        .from("demo_oura_sleep_records")
        .select("id, sleep_start_at, wake_at, sleep_minutes")
        .eq("is_deleted", false)
        .lte("sleep_start_at", toIso)
        .gte("wake_at", fromIso)
        .order("wake_at", { ascending: true }),
      admin
        .from("demo_google_calendar_events")
        .select("id, google_event_id, calendar_name, title, start_at, end_at")
        .eq("is_deleted", false)
        .lte("start_at", calendarToIso)
        .gte("end_at", calendarFromIso)
        .order("start_at", { ascending: true }),
      // Toggl は end_at が null (進行中) を許容する。end_at IS NULL もしくは
      // end_at >= fromIso のものだけを DB 側で絞り込み、JS の overlaps() で最終判定する。
      admin
        .from("demo_toggl_time_entries")
        .select("id, toggl_entry_id, title, project_id, project_name, start_at, end_at")
        .eq("is_deleted", false)
        .lte("start_at", toIso)
        .or(`end_at.gte.${fromIso},end_at.is.null`)
        .order("start_at", { ascending: true }),
    ]);

    if (sleepRes.error) throw sleepRes.error;
    if (calendarRes.error) throw calendarRes.error;
    if (togglRes.error) throw togglRes.error;

    // DB クエリは inclusive bound のため、range.end に exact-touch する
    // 翌日分の sleep / 境界線上の calendar event が混入しうる。再フィルタで除外する。
    // (本番 /api/summary と同じ判定ロジック)
    const rangeStartMs = internalRange.start.getTime();
    const rangeEndMs = internalRange.end.getTime();
    sleepRows = ((sleepRes.data ?? []) as SleepRow[]).filter((r) => {
      const s = new Date(r.sleep_start_at).getTime();
      const e = new Date(r.wake_at).getTime();
      return s < rangeEndMs && e >= rangeStartMs;
    });
    const allCalendarRows = (calendarRes.data ?? []) as CalendarRow[];
    calendarRows = allCalendarRows.filter((r) => overlaps(internalRange, r.start_at, r.end_at));
    // Issue #201: target_date (タイムゾーン局所) の 00:00–24:00 と重なる予定。
    const dayStartMs = dayBounds.start.getTime();
    const dayEndMs = dayBounds.end.getTime();
    calendarRowsForDay = allCalendarRows.filter((r) => {
      const s = new Date(r.start_at).getTime();
      const e = new Date(r.end_at).getTime();
      return s < dayEndMs && e > dayStartMs;
    });
    togglRows = ((togglRes.data ?? []) as TogglRow[]).filter((r) =>
      overlaps(internalRange, r.start_at, r.end_at)
    );
  }

  // -- Timeline (SPEC §4.2) ------------------------------------------------
  const timeline: Timeline = {
    sleep: sleepRows.map<SleepTimelineEntry>((r) => ({
      id: r.id,
      sleep_start_at: r.sleep_start_at,
      wake_at: r.wake_at,
      sleep_minutes: r.sleep_minutes,
    })),
    calendar: calendarRows.map<CalendarTimelineEntry>((r) => ({
      id: r.id,
      google_event_id: r.google_event_id,
      // デモテーブルは calendar_id を保持しない (本番のみ持つ列)。
      // 除外設定はデモには適用しないので null + is_excluded:false で OK。
      calendar_id: null,
      calendar_name: r.calendar_name,
      title: r.title,
      start_at: r.start_at,
      end_at: r.end_at,
      is_excluded: false,
    })),
    toggl: togglRows.map<TogglTimelineEntry>((r) => ({
      id: r.id,
      toggl_entry_id: r.toggl_entry_id,
      title: r.title,
      project_id: r.project_id,
      project_name: r.project_name,
      start_at: r.start_at,
      end_at: r.end_at,
    })),
  };

  // -- Today's ME (SPEC §4.1) ----------------------------------------------
  // デモでは 3 サービス全て「連携済み」相当として todays_me に値を返す。
  // サービス未連携の概念はデモには無い。

  // Oura: 起床日 = target_date の睡眠セッションを合算し、内訳を sessions に
  // 列挙する (起床①②…)。集計は本番 /api/summary と共通のヘルパに委譲する。
  const oura: TodaysMe["oura"] = buildTodaysMeOura(sleepRows, date, timezone);

  // Google: 集計値 (total_minutes) は wake range と重なる時間で計算する。
  // 累積 drift を避けるため ms で足し上げ、最後にまとめて分へ丸める。
  //
  // Issue #201: 予定一覧 (events) は target_date (タイムゾーン局所) の
  // 00:00–24:00 で抽出する。ダッシュボードの metric--calendar カードで
  // 「未到達 / 進行中 / 完了」を絵文字付きで一覧表示するため、wake range
  // 外の未来予定も含める。
  let google: TodaysMe["google"];
  {
    let totalMs = 0;
    if (internalRange) {
      for (const ev of calendarRows) {
        const ms = overlappingMs(internalRange, ev.start_at, ev.end_at);
        if (ms <= 0) continue;
        totalMs += ms;
      }
    }
    const events: CalendarTimelineEntry[] = calendarRowsForDay.map((r) => ({
      id: r.id,
      google_event_id: r.google_event_id,
      // デモテーブルは calendar_id を保持しないため、除外設定もデモでは
      // 適用しない (timeline 側と同じ扱い)。
      calendar_id: null,
      calendar_name: r.calendar_name,
      title: r.title,
      start_at: r.start_at,
      end_at: r.end_at,
      is_excluded: false,
    }));
    google = {
      total_minutes: msToMinutes(totalMs),
      events,
    };
  }

  // Toggl: wake range と重なる時間で (タイトル, プロジェクト) 別に集計
  // (Issue #112)。本番 /api/summary と同じバケット方式。
  let toggl: TodaysMe["toggl"];
  {
    const byKey = new Map<string, { title: string; project_name: string | null; ms: number }>();
    let totalMs = 0;
    if (internalRange) {
      for (const t of togglRows) {
        const ms = overlappingMs(internalRange, t.start_at, t.end_at);
        if (ms <= 0) continue;
        totalMs += ms;
        const title = t.title ?? "";
        const projectName = t.project_name ?? null;
        const key = `${title} ${projectName ?? ""}`;
        const cur = byKey.get(key);
        if (cur) {
          cur.ms += ms;
        } else {
          byKey.set(key, { title, project_name: projectName, ms });
        }
      }
    }
    toggl = {
      total_minutes: msToMinutes(totalMs),
      by_title: Array.from(byKey.values()).map((v) => ({
        title: v.title,
        project_name: v.project_name,
        minutes: msToMinutes(v.ms),
      })),
    };
  }

  // -- レスポンス -----------------------------------------------------------
  const wake_range: WakeRange | null = internalRange
    ? {
        start: internalRange.start.toISOString(),
        end: internalRange.end.toISOString(),
      }
    : null;

  const response: SummaryResponse = {
    target_date: date,
    timezone,
    wake_range,
    // デモに Todoist データは無いため todoist レーンは常に null (Issue #206)。
    todays_me: { oura, google, toggl, todoist: null },
    timeline,
    free_time_notes: demoFreeTimeNotes.filter((note) => note.target_date === date),
    free_time_notes_available: true,
    // デモは sync しないため常に空。
    sync_statuses: [],
  };

  return parseOrThrow(summaryResponseSchema, response);
});
