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
import { requireUserIdAllowCookie } from "../utils/auth";
import { listServiceConnections } from "../utils/serviceConnection";
import { getSupabaseAdmin } from "../utils/supabaseAdmin";
import { parseOrThrow } from "../utils/validation";
import {
  overlaps,
  targetDateOf,
  wakeRangeOf,
  type WakeRange as InternalWakeRange,
} from "../utils/wakeRange";

interface SleepRow {
  id: string;
  sleep_start_at: string;
  wake_at: string;
  sleep_minutes: number | null;
}

interface CalendarRow {
  id: string;
  google_event_id: string;
  // Issue #131 Phase 4: 同期経路は connection_id を埋める。NOT NULL 制約済み。
  connection_id: string;
  calendar_id: string;
  calendar_name: string | null;
  title: string | null;
  start_at: string;
  end_at: string;
}

interface TogglRow {
  id: string;
  toggl_entry_id: string;
  title: string | null;
  // Issue #112: Toggl の project_id / project_name。未割当 / 未解決は null。
  project_id: number | null;
  project_name: string | null;
  start_at: string;
  end_at: string | null;
}

interface TodoistRow {
  content: string | null;
  project_name: string | null;
  completed_at: string;
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
  const userId = await requireUserIdAllowCookie(event);
  const { date } = parseOrThrow(summaryRequestSchema, getQuery(event));

  const admin = getSupabaseAdmin();

  // -- 前段クエリ (Issue #143) ---------------------------------------------
  // 以下 4 つは userId / date だけに依存し相互に独立しているので並列で叩く。
  // wakeRangeOf は timezone を必要とするためここでは並行させず、結果を受けてから呼ぶ。
  //   1. users.timezone
  //   2. google_excluded_calendars
  //   3. listServiceConnections (todays_me の null 判定用)
  //   4. daily_sync_statuses (Timeline 構築後に消費するが date 既知なので前出し)
  const [userRes, excludedRes, connections, syncRes] = await Promise.all([
    admin.from("users").select("timezone").eq("id", userId).maybeSingle(),
    admin
      .from("google_excluded_calendars")
      .select("connection_id, calendar_id")
      .eq("user_id", userId),
    listServiceConnections(userId),
    admin
      .from("daily_sync_statuses")
      .select("source, status, last_synced_at, error_message")
      .eq("user_id", userId)
      .eq("target_date", date),
  ]);

  // -- user (timezone) -----------------------------------------------------
  if (userRes.error) {
    throw createError({
      statusCode: 500,
      statusMessage: "failed to load user",
    });
  }
  // users 行は signup 時の trigger で作成される前提。欠落時に Asia/Tokyo に
  // fallback するとデータ整合性問題を黙って隠してしまうので、明示的に 500 を返す。
  if (!userRes.data) {
    throw createError({
      statusCode: 500,
      statusMessage: "user profile is missing",
    });
  }
  const timezone = userRes.data.timezone;

  // -- 除外カレンダー (Issue #131 Phase 5: 接続単位) -----------------------
  // Phase 5 で `google_excluded_calendars` テーブル (connection_id 単位) に
  // 移行した。同じ calendar_id がアカウント間で別物を指すケースに備えて、
  // 除外判定キーは `${connection_id}|${calendar_id}` の合成文字列にする。
  if (excludedRes.error) {
    throw createError({
      statusCode: 500,
      statusMessage: `failed to load excluded calendars: ${excludedRes.error.message}`,
    });
  }
  const excludedKeys = new Set<string>(
    (excludedRes.data ?? []).map((r) => {
      const row = r as { connection_id: string; calendar_id: string };
      return `${row.connection_id}|${row.calendar_id}`;
    })
  );
  function isExcluded(connectionId: string, calendarId: string): boolean {
    return excludedKeys.has(`${connectionId}|${calendarId}`);
  }

  // -- service connection 状況 (todays_me の null 判定に使う) ---------------
  const connected = new Set(
    connections.filter((c) => c.status === "connected").map((c) => c.provider)
  );

  // -- wake range (timezone に依存するため前段の Promise.all 後に実行) ----
  const internalRange = await wakeRangeOf(date, userId, {
    client: admin,
    timezone,
  });

  // -- records (wake range と重なるもの) -----------------------------------
  let sleepRows: SleepRow[] = [];
  let calendarRows: CalendarRow[] = [];
  let togglRows: TogglRow[] = [];
  let todoistRows: TodoistRow[] = [];

  if (internalRange) {
    const fromIso = internalRange.start.toISOString();
    const toIso = internalRange.end.toISOString();

    const [sleepRes, calendarRes, togglRes, todoistRes] = await Promise.all([
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
        .select(
          "id, google_event_id, connection_id, calendar_id, calendar_name, title, start_at, end_at"
        )
        .eq("user_id", userId)
        .eq("is_deleted", false)
        .lte("start_at", toIso)
        .gte("end_at", fromIso)
        .order("start_at", { ascending: true }),
      // Toggl は end_at が null (進行中) を許容する。end_at IS NULL もしくは
      // end_at >= fromIso のものだけを DB 側で絞り込み、JS の overlaps() で最終判定する。
      admin
        .from("toggl_time_entries")
        .select("id, toggl_entry_id, title, project_id, project_name, start_at, end_at")
        .eq("user_id", userId)
        .eq("is_deleted", false)
        .lte("start_at", toIso)
        .or(`end_at.gte.${fromIso},end_at.is.null`)
        .order("start_at", { ascending: true }),
      // Todoist 完了タスク (Issue #206) は「完了した瞬間」の点イベントなので、
      // 期間 overlap ではなく completed_at が wake range に入るかで読む。
      admin
        .from("todoist_completed_tasks")
        .select("content, project_name, completed_at")
        .eq("user_id", userId)
        .eq("is_deleted", false)
        .gte("completed_at", fromIso)
        .lte("completed_at", toIso)
        .order("completed_at", { ascending: true }),
    ]);

    if (sleepRes.error) throw sleepRes.error;
    if (calendarRes.error) throw calendarRes.error;
    if (togglRes.error) throw togglRes.error;
    if (todoistRes.error) throw todoistRes.error;
    todoistRows = (todoistRes.data ?? []) as TodoistRow[];

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
      overlaps(internalRange, r.start_at, r.end_at)
    );
    togglRows = ((togglRes.data ?? []) as TogglRow[]).filter((r) =>
      overlaps(internalRange, r.start_at, r.end_at)
    );
  } else {
    // wake 記録が無い日は wake range を定義できないため、Todoist 完了タスクのみ
    // ユーザー TZ の暦日 (= 同期時に targetDateOf で振った target_date) に
    // フォールバックして読む (Issue #206)。他レーンは range 前提の集計なので
    // 従来どおり空のまま。
    const { data, error } = await admin
      .from("todoist_completed_tasks")
      .select("content, project_name, completed_at")
      .eq("user_id", userId)
      .eq("is_deleted", false)
      .eq("target_date", date)
      .order("completed_at", { ascending: true });
    if (error) throw error;
    todoistRows = (data ?? []) as TodoistRow[];
  }

  // -- sync statuses (Issue #143 で前段 Promise.all に移動済み) -----------
  if (syncRes.error) throw syncRes.error;

  const sync_statuses: SyncStatusEntry[] = ((syncRes.data ?? []) as SyncStatusRow[]).map((r) => ({
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
      calendar_id: r.calendar_id,
      calendar_name: r.calendar_name,
      title: r.title,
      start_at: r.start_at,
      end_at: r.end_at,
      is_excluded: isExcluded(r.connection_id, r.calendar_id),
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
    // 「ベッドにいた時間」は wake_at − sleep_start_at の長さ。sleep_minutes は
    // Oura の total_sleep_duration なので、入眠前/中途覚醒の「ベッドにいたが寝て
    // いない時間」が落ちる。両方並べて見せたい (dashboard Oura)。
    const timeInBedMinutes = todayWake
      ? Math.round(
          (new Date(todayWake.wake_at).getTime() - new Date(todayWake.sleep_start_at).getTime()) /
            60000
        )
      : null;
    oura = {
      sleep_minutes: todayWake?.sleep_minutes ?? null,
      time_in_bed_minutes: timeInBedMinutes,
      wake_at: todayWake?.wake_at ?? null,
    };
  }

  // Google: wake range と重なる時間で集計。
  // 累積 drift を避けるため ms で足し上げ、最後にまとめて分へ丸める。
  // 除外対象 (Issue #131 Phase 5 で google_excluded_calendars テーブルに
  // 移行) は集計から外す (Issue #108)。
  //
  // Issue #131 Phase 7: 複数 Google アカウント連携で同名カレンダー
  // (例: "プライベート") が衝突するケースに備え、まず (calendar_name,
  // connection_id) で集計し、衝突したラベルだけ "<name> (<email>)" に
  // 接尾辞を付ける。1 接続しか登場しない名前は素のままにする。
  let google: TodaysMe["google"] = null;
  if (connected.has("google")) {
    // connection_id → 表示用 email を引くマップを作る。account_email が無い
    // 行 (= 旧データ / id_token から email を取れなかった) は provider_user_id
    // の末尾 4 桁にフォールバックする。
    const { data: googleConnRows, error: connErr } = await admin
      .from("service_connections")
      .select("id, provider_user_id, account_email")
      .eq("user_id", userId)
      .eq("provider", "google");
    if (connErr) {
      throw createError({
        statusCode: 500,
        statusMessage: `failed to load google connection labels: ${connErr.message}`,
      });
    }
    const accountLabelByConn = new Map<string, string>();
    for (const r of googleConnRows ?? []) {
      const row = r as {
        id: string;
        provider_user_id: string | null;
        account_email: string | null;
      };
      const label =
        row.account_email ??
        (row.provider_user_id ? `…${row.provider_user_id.slice(-4)}` : "unknown");
      accountLabelByConn.set(row.id, label);
    }

    // (calendar_name, connection_id) ペア単位の集計 + name ごとに登場した
    // connection_id の集合を別途持つ。
    const byNameConnMs = new Map<string, Map<string, number>>();
    let totalMs = 0;
    if (internalRange) {
      for (const ev of calendarRows) {
        if (isExcluded(ev.connection_id, ev.calendar_id)) continue;
        const ms = overlappingMs(internalRange, ev.start_at, ev.end_at);
        if (ms <= 0) continue;
        totalMs += ms;
        const name = ev.calendar_name ?? "";
        let inner = byNameConnMs.get(name);
        if (!inner) {
          inner = new Map<string, number>();
          byNameConnMs.set(name, inner);
        }
        inner.set(ev.connection_id, (inner.get(ev.connection_id) ?? 0) + ms);
      }
    }

    const byCalendar: { calendar_name: string; minutes: number }[] = [];
    for (const [name, perConn] of byNameConnMs) {
      if (perConn.size <= 1) {
        // 衝突なし → 名前のみで 1 エントリにまとめる。
        const ms = Array.from(perConn.values()).reduce((a, b) => a + b, 0);
        byCalendar.push({ calendar_name: name, minutes: msToMinutes(ms) });
      } else {
        // 衝突あり → アカウント別に "<name> (<email>)" を出す。
        for (const [connId, ms] of perConn) {
          const label = accountLabelByConn.get(connId) ?? "unknown";
          byCalendar.push({
            calendar_name: `${name} (${label})`,
            minutes: msToMinutes(ms),
          });
        }
      }
    }

    google = {
      total_minutes: msToMinutes(totalMs),
      by_calendar: byCalendar,
    };
  }

  // Toggl: wake range と重なる時間で (タイトル, プロジェクト) 別に集計。
  // Issue #112: 同名タイトルでも異なる project に紐付くものは別バケットにし、
  // by_title の各エントリに project_name を持たせる。project 未割当は null。
  // 集計キーは `${title} ${project_name ?? ""}` (区切り文字でタイトルと
  // プロジェクト名の衝突を防ぐ)。
  let toggl: TodaysMe["toggl"] = null;
  if (connected.has("toggl")) {
    const byKey = new Map<string, { title: string; project_name: string | null; ms: number }>();
    let totalMs = 0;
    if (internalRange) {
      for (const t of togglRows) {
        const ms = overlappingMs(internalRange, t.start_at, t.end_at);
        if (ms <= 0) continue;
        totalMs += ms;
        const title = t.title ?? "";
        const projectName = t.project_name ?? null;
        const key = `${title} ${projectName ?? ""}`;
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

  // Todoist: 日記用 Markdown の「完了タスク」セクション用 (Issue #206)。
  // タイムラインには出さない (ユーザー決定) ため、完了タスクの列挙のみ。
  let todoist: TodaysMe["todoist"] = null;
  if (connected.has("todoist")) {
    todoist = {
      completed: todoistRows.map((r) => ({
        content: r.content ?? "",
        project_name: r.project_name,
        completed_at: r.completed_at,
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
    todays_me: { oura, google, toggl, todoist },
    timeline,
    sync_statuses,
  };

  return parseOrThrow(summaryResponseSchema, response);
});
