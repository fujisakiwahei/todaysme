// =============================================================================
// GET /api/summary?date=YYYY-MM-DD
// SPEC §9.1 / §9.3 / §10 / Issue #38
//
//   - DB のみを読む。外部 API は叩かない (refresh の責務)。
//   - users.timezone をもとに wake range を計算し、各サービスのレコードは
//     `target_date` 完全一致ではなく start_at/end_at の重なりで読む (SPEC §11.2)。
//   - サービス未連携時は todays_me の該当キーを null にする。
//   - レスポンスは Zod スキーマで検証してから返す (SPEC §12.3)。
// =============================================================================
import {
  summaryRequestSchema,
  summaryResponseSchema,
  type CalendarTimelineEntry,
  type SleepTimelineEntry,
  type SummaryResponse,
  type SyncStatusEntry,
  type Timeline,
  type TodaysMe,
  type TogglTimelineEntry,
  type WakeRange,
} from "../../shared/schemas";
import { requireUserId } from "../utils/auth";
import { listServiceConnections } from "../utils/serviceConnection";
import { getSupabaseAdmin } from "../utils/supabaseAdmin";
import { parseOrThrow } from "../utils/validation";
import {
  overlaps,
  wakeRangeOf,
  type WakeRange as InternalWakeRange,
} from "../utils/wakeRange";

// SPEC §3 分類ルール: 現状は calendar_name === "MTG" を MTG とみなす想定。
// 本番カレンダー名が確定したらここを書き換える。
const MEETING_CALENDAR_NAMES = new Set(["MTG"]);

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
  start_at: string;
  end_at: string | null;
}

interface SyncStatusRow {
  source: SyncStatusEntry["source"];
  status: SyncStatusEntry["status"];
  last_synced_at: string | null;
  error_message: string | null;
}

// wake range と [start, end] の重なり部分の長さ (分)。
// end が null (進行中の Toggl エントリ) のときは range.end までで打ち切る。
function overlappingMinutes(
  range: InternalWakeRange,
  start: string,
  end: string | null,
): number {
  const s = Math.max(new Date(start).getTime(), range.start.getTime());
  const eMs = end == null ? range.end.getTime() : new Date(end).getTime();
  const e = Math.min(eMs, range.end.getTime());
  if (e <= s) return 0;
  return Math.round((e - s) / 60000);
}

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const { date } = parseOrThrow(summaryRequestSchema, getQuery(event));

  const admin = getSupabaseAdmin();

  // -- timezone -------------------------------------------------------------
  const { data: userRow, error: userErr } = await admin
    .from("users")
    .select("timezone")
    .eq("id", userId)
    .maybeSingle();
  if (userErr) {
    throw createError({
      statusCode: 500,
      statusMessage: "failed to load user",
    });
  }
  const timezone = userRow?.timezone ?? "Asia/Tokyo";

  // -- wake range -----------------------------------------------------------
  const internalRange = await wakeRangeOf(date, userId, {
    client: admin,
    timezone,
  });

  // -- service connection 状況 (todays_me の null 判定に使う) ---------------
  const connections = await listServiceConnections(userId);
  const connected = new Set(
    connections.filter((c) => c.status === "connected").map((c) => c.provider),
  );

  // -- records (wake range と重なるもの) -----------------------------------
  let sleepRows: SleepRow[] = [];
  let calendarRows: CalendarRow[] = [];
  let togglRows: TogglRow[] = [];

  if (internalRange) {
    const fromIso = internalRange.start.toISOString();
    const toIso = internalRange.end.toISOString();

    const [sleepRes, calendarRes, togglRes] = await Promise.all([
      // 睡眠は sleep_start_at..wake_at が wake range と重なるもの。
      admin
        .from("oura_sleep_records")
        .select("id, sleep_start_at, wake_at, sleep_minutes")
        .eq("user_id", userId)
        .eq("is_deleted", false)
        .lte("sleep_start_at", toIso)
        .gte("wake_at", fromIso)
        .order("wake_at", { ascending: true }),
      admin
        .from("google_calendar_events")
        .select("id, google_event_id, calendar_name, title, start_at, end_at")
        .eq("user_id", userId)
        .eq("is_deleted", false)
        .lte("start_at", toIso)
        .gte("end_at", fromIso)
        .order("start_at", { ascending: true }),
      // Toggl は end_at が null (進行中) を許容する。end_at IS NULL もしくは
      // end_at >= fromIso のものだけを DB 側で絞り込み、JS の overlaps() で最終判定する。
      admin
        .from("toggl_time_entries")
        .select("id, toggl_entry_id, title, start_at, end_at")
        .eq("user_id", userId)
        .eq("is_deleted", false)
        .lte("start_at", toIso)
        .or(`end_at.gte.${fromIso},end_at.is.null`)
        .order("start_at", { ascending: true }),
    ]);

    if (sleepRes.error) throw sleepRes.error;
    if (calendarRes.error) throw calendarRes.error;
    if (togglRes.error) throw togglRes.error;

    sleepRows = (sleepRes.data ?? []) as SleepRow[];
    calendarRows = (calendarRes.data ?? []) as CalendarRow[];
    togglRows = ((togglRes.data ?? []) as TogglRow[]).filter((r) =>
      overlaps(internalRange, r.start_at, r.end_at),
    );
  }

  // -- sync statuses --------------------------------------------------------
  const { data: syncRows, error: syncErr } = await admin
    .from("daily_sync_statuses")
    .select("source, status, last_synced_at, error_message")
    .eq("user_id", userId)
    .eq("target_date", date);
  if (syncErr) throw syncErr;

  const sync_statuses: SyncStatusEntry[] = (
    (syncRows ?? []) as SyncStatusRow[]
  ).map((r) => ({
    source: r.source,
    status: r.status,
    last_synced_at: r.last_synced_at,
    error_message: r.error_message,
  }));

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
      calendar_name: r.calendar_name,
      title: r.title,
      start_at: r.start_at,
      end_at: r.end_at,
    })),
    toggl: togglRows.map<TogglTimelineEntry>((r) => ({
      id: r.id,
      toggl_entry_id: r.toggl_entry_id,
      title: r.title,
      start_at: r.start_at,
      end_at: r.end_at,
    })),
  };

  // -- Today's ME (SPEC §4.1) ----------------------------------------------
  // Oura: 起床日 = target_date となる sleep を選ぶ。
  //   wake range には前日夜〜当日朝の睡眠が入るので、wake_at が target_date と
  //   一致するレコードに絞る。同一日に複数の sleep が存在する場合
  //   (仮眠等) は wake_at が最も遅いものを採用 (決定的に選ぶため)。
  let oura: TodaysMe["oura"] = null;
  if (connected.has("oura")) {
    const wakeDateFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const todayWake = sleepRows
      .filter((r) => wakeDateFmt.format(new Date(r.wake_at)) === date)
      .sort(
        (a, b) => new Date(b.wake_at).getTime() - new Date(a.wake_at).getTime(),
      )[0];
    oura = {
      sleep_minutes: todayWake?.sleep_minutes ?? null,
      wake_at: todayWake?.wake_at ?? null,
    };
  }

  // Google: wake range と重なる時間で集計。
  let google: TodaysMe["google"] = null;
  if (connected.has("google")) {
    const byCalendar = new Map<string, number>();
    let total = 0;
    let meeting = 0;
    if (internalRange) {
      for (const ev of calendarRows) {
        const m = overlappingMinutes(internalRange, ev.start_at, ev.end_at);
        if (m <= 0) continue;
        total += m;
        const name = ev.calendar_name ?? "";
        byCalendar.set(name, (byCalendar.get(name) ?? 0) + m);
        if (ev.calendar_name && MEETING_CALENDAR_NAMES.has(ev.calendar_name)) {
          meeting += m;
        }
      }
    }
    google = {
      total_minutes: total,
      meeting_minutes: meeting,
      by_calendar: Array.from(byCalendar.entries()).map(
        ([calendar_name, minutes]) => ({ calendar_name, minutes }),
      ),
    };
  }

  // Toggl: wake range と重なる時間でタイトル別集計。
  let toggl: TodaysMe["toggl"] = null;
  if (connected.has("toggl")) {
    const byTitle = new Map<string, number>();
    let total = 0;
    if (internalRange) {
      for (const t of togglRows) {
        const m = overlappingMinutes(internalRange, t.start_at, t.end_at);
        if (m <= 0) continue;
        total += m;
        const title = t.title ?? "";
        byTitle.set(title, (byTitle.get(title) ?? 0) + m);
      }
    }
    toggl = {
      total_minutes: total,
      by_title: Array.from(byTitle.entries()).map(([title, minutes]) => ({
        title,
        minutes,
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
    todays_me: { oura, google, toggl },
    timeline,
    sync_statuses,
  };

  return parseOrThrow(summaryResponseSchema, response);
});
