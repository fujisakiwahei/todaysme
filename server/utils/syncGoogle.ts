// =============================================================================
// Google Calendar 同期ヘルパ (Issue #39 / Issue #131 Phase 4)
// SPEC §3 / §10.4 / §11.3
// docs/designs/multi-google-account.md §4.3
//
//   - `target_date` ± 1 日のウィンドウを Google Calendar API から取得し、
//     `google_calendar_events` に external id (`user_id, connection_id,
//     calendar_id, google_event_id`) 単位で upsert する。
//   - Google `event.id` はカレンダー内ユニークなだけで、複数カレンダーから
//     同期するとカレンダー跨ぎで同じ ID が出現しうる。さらに Issue #131 で
//     アカウント (= connection_id) 跨ぎでも同 calendar_id が衝突しうるため、
//     unique key は (user_id, connection_id, calendar_id, google_event_id)。
//   - 各 calendar 単位で取得し、calendar_name (= summaryOverride > summary) を
//     付与する。
//   - 差分同期で受信した `cancelled` イベント (deletedEventIds) は
//     `is_deleted = true` でソフトデリート (connection_id × calendar_id でスコープ)。
//   - 加えて、対象日に紐づく既存行のうち取得結果に含まれないものも
//     (connection_id × calendar 単位で) ソフトデリートする (SPEC §11.3)。
//   - 同じく今回の取得に登場しない calendar_id (= 購読解除) も connection_id
//     スコープで掃除する。別アカウントの同名 calendar_id を巻き込まない。
//   - MVP では syncToken は永続化しない。毎回 timeMin/timeMax で全件再取得する。
//   - Issue #131 Phase 4: ユーザーの Google 接続行をループする。1 接続の
//     refresh 失敗が他接続を巻き込まないよう、各接続を独立 try/catch する。
//     全接続が失敗したときだけ最終的に throw する。少なくとも 1 件成功すれば
//     google プロバイダ全体のステータスは success とする (per 接続の error は
//     service_connections.status に既に書き込まれている)。
// =============================================================================
import { getGoogleData } from "./getGoogleData";
import {
  withFreshAccessTokenFromRow,
  type ServiceConnectionTokenRow,
} from "./serviceConnection";
import { getSupabaseAdmin } from "./supabaseAdmin";

const GOOGLE_CALENDAR_EVENTS = "google_calendar_events";

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 対象日の前後 1 日を「現地時間 00:00」相当の UTC instant にざっくり丸めて
// timeMin/timeMax として渡す。Google API 側は inclusive/exclusive を意識した
// 比較で十分受け止めてくれるため、ここでは UTC 端点で OK。
function dateBoundaries(targetDate: string): {
  timeMin: string;
  timeMax: string;
} {
  const startDay = shiftDate(targetDate, -1);
  const endDay = shiftDate(targetDate, 2); // 翌々日 00:00 を上限 (exclusive 相当)
  return {
    timeMin: `${startDay}T00:00:00Z`,
    timeMax: `${endDay}T00:00:00Z`,
  };
}

export async function syncGoogleForDate(
  userId: string,
  targetDate: string,
  timezone: string,
  connections: readonly ServiceConnectionTokenRow[],
): Promise<void> {
  if (connections.length === 0) {
    // 通常 runRefresh.ts 側で connected provider に google を含めない経路で
    // フィルタされるため到達しないが、race condition で空に見える可能性に
    // 備えて no-op を許容する。
    return;
  }

  const { timeMin, timeMax } = dateBoundaries(targetDate);

  let successCount = 0;
  const errors: Error[] = [];

  // 各接続を独立に処理する。1 接続の refresh 失敗 (OauthRefreshError) は
  // performRefresh 側で service_connections.status='error' に落ちており、
  // 他接続の sync を巻き込まないようここで catch する。
  for (const connection of connections) {
    try {
      await syncOneGoogleConnection({
        userId,
        connection,
        targetDate,
        timezone,
        timeMin,
        timeMax,
      });
      successCount += 1;
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // 全接続失敗 → 呼び出し元 (runRefresh) で google プロバイダ全体を failed に
  // 落としてもらうため throw する。少なくとも 1 件成功 → success とみなし
  // throw しない (個別接続の状態は service_connections.status に残る)。
  if (successCount === 0 && errors.length > 0) {
    const summary = errors.map((e) => e.message).join("; ");
    throw new Error(`all google connection syncs failed: ${summary}`);
  }
}

interface SyncOneGoogleConnectionInput {
  userId: string;
  connection: ServiceConnectionTokenRow;
  targetDate: string;
  timezone: string;
  timeMin: string;
  timeMax: string;
}

async function syncOneGoogleConnection(
  input: SyncOneGoogleConnectionInput,
): Promise<void> {
  const { userId, connection, targetDate, timezone, timeMin, timeMax } = input;
  const connectionId = connection.id;

  const { calendars } = await withFreshAccessTokenFromRow(
    connection,
    (accessToken) =>
      getGoogleData({
        accessToken,
        timezone,
        timeMin,
        timeMax,
      }),
  );

  const admin = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  // 全カレンダーぶんの events をまとめて upsert する。
  // onConflict には (user_id, connection_id, calendar_id, google_event_id) を
  // 使うことで、event_id がカレンダー跨ぎ / アカウント跨ぎで衝突しても別 row
  // として扱う。
  const allFetched = calendars.flatMap((c) => c.events);
  if (allFetched.length > 0) {
    const rows = allFetched.map((e) => ({
      user_id: userId,
      connection_id: connectionId,
      target_date: e.target_date,
      calendar_id: e.calendar_id,
      google_event_id: e.google_event_id,
      calendar_name: e.calendar_name,
      title: e.title,
      start_at: e.start_at,
      end_at: e.end_at,
      is_deleted: false,
      updated_at: nowIso,
    }));

    const { error: upsertError } = await admin
      .from(GOOGLE_CALENDAR_EVENTS)
      .upsert(rows, {
        onConflict: "user_id,connection_id,calendar_id,google_event_id",
      });
    if (upsertError) {
      throw new Error(
        `failed to upsert ${GOOGLE_CALENDAR_EVENTS}: ${upsertError.message}`,
      );
    }
  }

  // 差分同期で「削除」と通知された event は connection_id × calendar_id で
  // スコープして is_deleted を立てる (アカウント跨ぎで同 id を巻き込まない)。
  for (const cal of calendars) {
    if (cal.deletedEventIds.length === 0) continue;
    const { error: deleteError } = await admin
      .from(GOOGLE_CALENDAR_EVENTS)
      .update({ is_deleted: true, updated_at: nowIso })
      .eq("user_id", userId)
      .eq("connection_id", connectionId)
      .eq("calendar_id", cal.calendarId)
      .in("google_event_id", cal.deletedEventIds);
    if (deleteError) {
      throw new Error(
        `failed to soft-delete cancelled events: ${deleteError.message}`,
      );
    }
  }

  // 対象日 × connection_id × calendar_id 単位で、今回取得結果に含まれない
  // event_id をソフトデリートする。connection_id でスコープしないと
  // 別アカウントの同名 calendar_id 行を巻き込んでしまう。
  // calendar 毎に SELECT を撃つと N+1 になるので、全 calendar をまとめて
  // 1 回の SELECT で取り、メモリ上で calendar_id 別に分けて diff を取る
  // (Issue #175)。
  const activeCalendarIds = calendars.map((c) => c.calendarId);
  if (activeCalendarIds.length > 0) {
    const { data: existing, error: readError } = await admin
      .from(GOOGLE_CALENDAR_EVENTS)
      .select("calendar_id, google_event_id")
      .eq("user_id", userId)
      .eq("connection_id", connectionId)
      .eq("target_date", targetDate)
      .eq("is_deleted", false)
      .in("calendar_id", activeCalendarIds);
    if (readError) {
      throw new Error(
        `failed to read ${GOOGLE_CALENDAR_EVENTS}: ${readError.message}`,
      );
    }

    const existingByCalendar = new Map<string, string[]>();
    for (const row of existing ?? []) {
      const record = row as unknown as Record<string, unknown>;
      const calId = record["calendar_id"];
      const eventId = record["google_event_id"];
      if (typeof calId !== "string" || typeof eventId !== "string") continue;
      const bucket = existingByCalendar.get(calId);
      if (bucket) {
        bucket.push(eventId);
      } else {
        existingByCalendar.set(calId, [eventId]);
      }
    }

    for (const cal of calendars) {
      const existingIds = existingByCalendar.get(cal.calendarId);
      if (!existingIds || existingIds.length === 0) continue;
      const keepIds = new Set(cal.events.map((e) => e.google_event_id));
      const toDelete = existingIds.filter((id) => !keepIds.has(id));
      if (toDelete.length === 0) continue;

      const { error: updateError } = await admin
        .from(GOOGLE_CALENDAR_EVENTS)
        .update({ is_deleted: true, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("connection_id", connectionId)
        .eq("calendar_id", cal.calendarId)
        .eq("target_date", targetDate)
        .in("google_event_id", toDelete);
      if (updateError) {
        throw new Error(
          `failed to soft-delete ${GOOGLE_CALENDAR_EVENTS}: ${updateError.message}`,
        );
      }
    }
  }

  // 今回の calendars に登場しない calendar_id (= ユーザーが Google 側で削除
  // / 購読解除したカレンダー) に紐づく既存行も、対象日ぶんはソフトデリート
  // する。これも connection_id でスコープする。
  await softDeleteEventsForRemovedCalendars({
    userId,
    connectionId,
    targetDate,
    activeCalendarIds,
  });
}

interface SoftDeleteRemovedCalendarsInput {
  userId: string;
  connectionId: string;
  targetDate: string;
  activeCalendarIds: readonly string[];
}

// ユーザーの calendarList から消えたカレンダー (購読解除 / Google 側で削除)
// に紐づく既存行を、対象日ぶん is_deleted=true にする。
// activeCalendarIds が空 (全カレンダー解除) のケースでも安全に動くように
// PostgREST の `not in` 構文 (= `not.in.(...)`) を組み立てる。
// connection_id でスコープすることで「別アカウントが同 calendar_id を購読
// している」ケースでも他接続の行を巻き込まない。
async function softDeleteEventsForRemovedCalendars(
  input: SoftDeleteRemovedCalendarsInput,
): Promise<void> {
  const admin = getSupabaseAdmin();

  let query = admin
    .from(GOOGLE_CALENDAR_EVENTS)
    .update({ is_deleted: true, updated_at: new Date().toISOString() })
    .eq("user_id", input.userId)
    .eq("connection_id", input.connectionId)
    .eq("target_date", input.targetDate)
    .eq("is_deleted", false);

  if (input.activeCalendarIds.length > 0) {
    // PostgREST の filter 形式: `not.in.("a","b")`。 calendar_id に
    // ダブルクォートが含まれる正規ケースは無いはずだが、念のため escape する。
    const escaped = input.activeCalendarIds
      .map((id) => `"${id.replace(/"/g, '""')}"`)
      .join(",");
    query = query.filter("calendar_id", "not.in", `(${escaped})`);
  }

  const { error } = await query;
  if (error) {
    throw new Error(
      `failed to soft-delete events for removed calendars: ${error.message}`,
    );
  }
}
