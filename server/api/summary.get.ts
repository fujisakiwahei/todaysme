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
  targetDateOf,
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

// wake range と [start, end] の重なり部分の長さ (ミリ秒)。
// end が null (進行中の Toggl エントリ) のときは range.end までで打ち切る。
// 分への丸めは累積 drift を避けるため呼び出し側で sum 後に 1 度だけ行う。
function overlappingMs(
  range: InternalWakeRange,
  start: string,
  end: string | null,
): number {
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
  // users 行は signup 時の trigger で作成される前提。欠落時に Asia/Tokyo に
  // fallback するとデータ整合性問題を黙って隠してしまうので、明示的に 500 を返す。
  if (!userRow) {
    throw createError({
      statusCode: 500,
      statusMessage: "user profile is missing",
    });
  }
  const timezone = userRow.timezone;

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

    // DB クエリは inclusive bound のため、range.end に exact-touch する
    // 翌日分の sleep / 境界線上の calendar event が混入しうる。再フィルタで除外する。
    //
    // sleep は wake range の「境界そのもの」を定義する記録で、main sleep は
    // wake_at === range.start が常に成立する。calendar/toggl と同じ overlaps()
    // (strict 両端) を使うと main sleep が必ず落ちて Oura summary が null になるため、
    // sleep だけは下限 inclusive (wake_at >= range.start) で判定する。
    // 上限は strict (sleep_start_at < range.end) なので、過去日の wakeRange.end ==
    // 翌日 sleep_start_at の境界レコードも除外できる。
    const rangeStartMs = internalRange.start.getTime();
    const rangeEndMs = internalRange.end.getTime();
    sleepRows = ((sleepRes.data ?? []) as SleepRow[]).filter((r) => {
      const s = new Date(r.sleep_start_at).getTime();
      const e = new Date(r.wake_at).getTime();
      return s < rangeEndMs && e >= rangeStartMs;
    });
    calendarRows = ((calendarRes.data ?? []) as CalendarRow[]).filter((r) =>
      overlaps(internalRange, r.start_at, r.end_at),
    );
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
  //   一致するレコードに絞る。同一日に複数 (仮眠等) が存在する場合は
  //   sleep_minutes が最も長いものを main sleep とみなして採用する。
  //   tie-break と sleep_minutes が null の場合は wake_at が最も遅いものを採用。
  let oura: TodaysMe["oura"] = null;
  if (connected.has("oura")) {
    // wake_at → YYYY-MM-DD への変換は targetDateOf に一元化 (ICU 依存の
    // `Intl.DateTimeFormat.format()` を直接使わないことで実装差異を回避する)。
    const todayWake = sleepRows
      .filter((r) => targetDateOf(r.wake_at, timezone) === date)
      .sort((a, b) => {
        const am = a.sleep_minutes ?? -1;
        const bm = b.sleep_minutes ?? -1;
        if (bm !== am) return bm - am;
        return new Date(b.wake_at).getTime() - new Date(a.wake_at).getTime();
      })[0];
    oura = {
      sleep_minutes: todayWake?.sleep_minutes ?? null,
      wake_at: todayWake?.wake_at ?? null,
    };
  }

  // Google: wake range と重なる時間で集計。
  // 累積 drift を避けるため ms で足し上げ、最後にまとめて分へ丸める。
  let google: TodaysMe["google"] = null;
  if (connected.has("google")) {
    const byCalendarMs = new Map<string, number>();
    let totalMs = 0;
    let meetingMs = 0;
    if (internalRange) {
      for (const ev of calendarRows) {
        const ms = overlappingMs(internalRange, ev.start_at, ev.end_at);
        if (ms <= 0) continue;
        totalMs += ms;
        const name = ev.calendar_name ?? "";
        byCalendarMs.set(name, (byCalendarMs.get(name) ?? 0) + ms);
        if (ev.calendar_name && MEETING_CALENDAR_NAMES.has(ev.calendar_name)) {
          meetingMs += ms;
        }
      }
    }
    google = {
      total_minutes: msToMinutes(totalMs),
      meeting_minutes: msToMinutes(meetingMs),
      by_calendar: Array.from(byCalendarMs.entries()).map(
        ([calendar_name, ms]) => ({
          calendar_name,
          minutes: msToMinutes(ms),
        }),
      ),
    };
  }

  // Toggl: wake range と重なる時間でタイトル別集計。
  // by_title は SPEC §4.1 の定義どおり title 単位で集約する。
  // Toggl の project_id は DB スキーマに保持していないため、別プロジェクトで
  // 同名タイトルを使うと同一バケットに入る。将来 project_id を永続化する
  // 場合はキーを (title, project_id) に拡張する。
  let toggl: TodaysMe["toggl"] = null;
  if (connected.has("toggl")) {
    const byTitleMs = new Map<string, number>();
    let totalMs = 0;
    if (internalRange) {
      for (const t of togglRows) {
        const ms = overlappingMs(internalRange, t.start_at, t.end_at);
        if (ms <= 0) continue;
        totalMs += ms;
        const title = t.title ?? "";
        byTitleMs.set(title, (byTitleMs.get(title) ?? 0) + ms);
      }
    }
    toggl = {
      total_minutes: msToMinutes(totalMs),
      by_title: Array.from(byTitleMs.entries()).map(([title, ms]) => ({
        title,
        minutes: msToMinutes(ms),
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
