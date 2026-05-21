// =============================================================================
// Google Calendar API v3 から対象期間のイベントを取得する内部モジュール
// SPEC §3 / §11.2 / Issue #42
//
//   - スコープは calendar.events.readonly のみ (server/utils/oauth/google.ts)。
//   - events.list + nextSyncToken による差分同期に対応する。
//     初回は timeMin/timeMax で全件取得し、最終ページで返る nextSyncToken を
//     呼び出し側が永続化しておけば、次回は syncToken のみで差分を取得できる。
//   - SPEC §3 の分類ルールに合わせて calendarList を引き、各イベントに
//     calendar_name (summaryOverride > summary) を載せて返す。
//   - レスポンスは shared/schemas/google.ts の Zod スキーマで検証する。
//
// 公開 API は getGoogleData(input) のみ。HTTP エンドポイントは公開しない
// (SPEC §9.1 注釈)。
// =============================================================================
import {
  googleCalendarListResponseSchema,
  googleEventsListResponseSchema,
  type GoogleCalendarEvent,
} from "../../shared/schemas";

import { targetDateOf } from "./wakeRange";

import { parseExternal } from "./validation";

const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const EVENTS_PAGE_SIZE = 250;

// =============================================================================
// 公開型
// =============================================================================

// google_calendar_events テーブル (SPEC §11.2) の挿入/更新で使う行形状。
// `id` / `user_id` / `created_at` / `updated_at` は呼び出し側で付与する。
export interface GoogleEventRow {
  google_event_id: string;
  calendar_name: string | null;
  title: string | null;
  start_at: string; // ISO 8601 (with offset)
  end_at: string; // ISO 8601 (with offset)
  target_date: string; // YYYY-MM-DD (user timezone)
}

export interface GetGoogleDataInput {
  accessToken: string;
  // target_date 算出と終日イベントの解釈に使う IANA タイムゾーン。
  timezone: string;
  // 初回 (= syncToken を持たない) フェッチ時に使う期間。RFC3339。
  // syncToken が指定された calendar については無視される (API 制約)。
  timeMin: string;
  timeMax: string;
  // calendarId -> 前回保存した syncToken。指定された calendar は差分同期で取得する。
  // 410 Gone が返った場合は syncToken を破棄し、timeMin/timeMax にフォールバックする。
  syncTokens?: Readonly<Record<string, string>>;
  // 取得対象 calendarId のホワイトリスト。省略時は calendarList.list の全件
  // (deleted を除く) を対象にする。
  calendarIds?: readonly string[];
}

export interface CalendarSyncResult {
  calendarId: string;
  calendarName: string | null;
  events: GoogleEventRow[];
  // 差分同期で returned された削除通知 (event.status === "cancelled")。
  // 呼び出し側で既存行の is_deleted を true に更新するために使う。
  deletedEventIds: string[];
  // 今回のフェッチで Google が発行した次回 syncToken。pagination 中は最終ページ
  // のみに付与され、途中ページでは null になる。
  nextSyncToken: string | null;
  // syncToken が失効 (410 Gone) して timeMin/timeMax にフォールバックした場合 true。
  // 呼び出し側で旧 syncToken を破棄するきっかけに使う。
  resyncedFromFullFetch: boolean;
}

export interface GetGoogleDataResult {
  calendars: CalendarSyncResult[];
}

// =============================================================================
// 公開関数
// =============================================================================

export async function getGoogleData(
  input: GetGoogleDataInput,
): Promise<GetGoogleDataResult> {
  const calendarMap = await fetchCalendarList(input.accessToken);

  const targetIds =
    input.calendarIds && input.calendarIds.length > 0
      ? input.calendarIds
      : Array.from(calendarMap.keys());

  const calendars: CalendarSyncResult[] = [];
  for (const calendarId of targetIds) {
    const calendarName = calendarMap.get(calendarId) ?? null;
    const result = await fetchCalendarEvents({
      accessToken: input.accessToken,
      calendarId,
      calendarName,
      timezone: input.timezone,
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      syncToken: input.syncTokens?.[calendarId],
    });
    calendars.push(result);
  }

  return { calendars };
}

// =============================================================================
// 内部実装
// =============================================================================

async function fetchCalendarList(
  accessToken: string,
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  let pageToken: string | undefined;

  do {
    const url = new URL(`${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList`);
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await googleFetch(url, accessToken);
    if (!res.ok) {
      throw new Error(`Google calendarList.list failed: HTTP ${res.status}`);
    }
    const json: unknown = await res.json();
    const parsed = parseExternal(
      googleCalendarListResponseSchema,
      json,
      "google",
    );
    for (const item of parsed.items) {
      if (item.deleted) continue;
      const name = item.summaryOverride ?? item.summary ?? null;
      map.set(item.id, name);
    }
    pageToken = parsed.nextPageToken;
  } while (pageToken);

  return map;
}

interface FetchCalendarEventsInput {
  accessToken: string;
  calendarId: string;
  calendarName: string | null;
  timezone: string;
  timeMin: string;
  timeMax: string;
  syncToken: string | undefined;
}

async function fetchCalendarEvents(
  input: FetchCalendarEventsInput,
): Promise<CalendarSyncResult> {
  const useSyncToken = Boolean(input.syncToken);
  let nextSyncToken: string | null = null;
  let pageToken: string | undefined;
  let resyncedFromFullFetch = false;
  const events: GoogleEventRow[] = [];
  const deletedEventIds: string[] = [];

  do {
    const url = new URL(
      `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(input.calendarId)}/events`,
    );
    url.searchParams.set("maxResults", String(EVENTS_PAGE_SIZE));
    url.searchParams.set("singleEvents", "true");
    if (useSyncToken && !resyncedFromFullFetch) {
      // syncToken 指定時は orderBy / timeMin / timeMax を併用不可
      url.searchParams.set("syncToken", input.syncToken!);
    } else {
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("timeMin", input.timeMin);
      url.searchParams.set("timeMax", input.timeMax);
    }
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await googleFetch(url, input.accessToken);

    // 410 Gone: syncToken が失効。timeMin/timeMax フェッチに切り替えてやり直す。
    if (res.status === 410 && useSyncToken && !resyncedFromFullFetch) {
      resyncedFromFullFetch = true;
      pageToken = undefined;
      // フォールバック開始: これまでの蓄積を破棄
      events.length = 0;
      deletedEventIds.length = 0;
      nextSyncToken = null;
      continue;
    }

    if (!res.ok) {
      throw new Error(
        `Google events.list failed for ${input.calendarId}: HTTP ${res.status}`,
      );
    }

    const json: unknown = await res.json();
    const parsed = parseExternal(
      googleEventsListResponseSchema,
      json,
      "google",
    );

    for (const event of parsed.items) {
      if (event.status === "cancelled") {
        deletedEventIds.push(event.id);
        continue;
      }
      const row = toEventRow(event, input.calendarName, input.timezone);
      if (row) events.push(row);
    }

    pageToken = parsed.nextPageToken;
    // nextSyncToken は最終ページにのみ付く
    nextSyncToken = parsed.nextSyncToken ?? null;
  } while (pageToken);

  return {
    calendarId: input.calendarId,
    calendarName: input.calendarName,
    events,
    deletedEventIds,
    nextSyncToken,
    resyncedFromFullFetch,
  };
}

function toEventRow(
  event: GoogleCalendarEvent,
  calendarName: string | null,
  timezone: string,
): GoogleEventRow | null {
  // superRefine により cancelled 以外は start/end が必ず存在する。
  if (!event.start || !event.end) return null;

  const startAt = resolveInstant(event.start, timezone);
  const endAt = resolveInstant(event.end, timezone, { allDayEnd: true });
  if (!startAt || !endAt) return null;

  return {
    google_event_id: event.id,
    calendar_name: calendarName,
    title: event.summary ?? null,
    start_at: startAt,
    end_at: endAt,
    target_date: targetDateOf(startAt, timezone),
  };
}

interface EventDateLike {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

// Google Calendar の start/end は時刻あり予定 (dateTime) と終日予定 (date) の
// 二系統。終日予定は YYYY-MM-DD のみ返るので、ユーザータイムゾーン (またはイベント
// 自身の timeZone 指定がある場合はそれ) で日の境界を ISO instant に解決する。
// end.date は exclusive (翌日 00:00 相当) なので allDayEnd 時は 1 日加算する。
function resolveInstant(
  value: EventDateLike,
  userTimezone: string,
  options: { allDayEnd?: boolean } = {},
): string | null {
  if (value.dateTime) return value.dateTime;
  if (!value.date) return null;

  const tz = value.timeZone ?? userTimezone;
  const date = options.allDayEnd ? addDays(value.date, 1) : value.date;
  return midnightInTimezoneToUtc(date, tz);
}

function addDays(yyyymmdd: string, days: number): string {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  // 12:00 UTC で組み立ててから加算することで DST 影響を避ける
  const base = new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + days);
  const yyyy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(base.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// YYYY-MM-DD の対象タイムゾーンにおける 00:00:00 を UTC instant (ISO) に変換する。
// Intl.DateTimeFormat で「ある UTC 瞬間」をターゲット TZ の現地表記に変換して
// 逆算し、ターゲット TZ で 00:00 になる UTC 瞬間を 1〜2 回の反復で求める
// (DST 切替日にも収束する)。
function midnightInTimezoneToUtc(yyyymmdd: string, timezone: string): string {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const targetLocalMs = Date.UTC(y!, m! - 1, d!, 0, 0, 0);

  let utc = targetLocalMs;
  for (let i = 0; i < 2; i++) {
    const offsetMs = getTimezoneOffsetMs(new Date(utc), timezone);
    utc = targetLocalMs - offsetMs;
  }
  return new Date(utc).toISOString();
}

// 指定 UTC 瞬間が、指定タイムゾーン上で何分ずれて見えるかを ms で返す。
// (local - utc)。例: UTC 00:00 を Asia/Tokyo で見ると 09:00 なので +9h 分。
function getTimezoneOffsetMs(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Missing ${type} in DateTimeFormat parts`);
    return Number(part.value);
  };

  const localAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return localAsUtc - at.getTime();
}

async function googleFetch(url: URL, accessToken: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
}
