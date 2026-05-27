// =============================================================================
// GET /api/connections/google/calendars?connection_id=<uuid>
// Issue #108 / Issue #131 Phase 5
//
//   指定された接続行 (= 個別 Google アカウント) が見ているカレンダー一覧を
//   返す。各カレンダーが稼働時間集計から除外されているか
//   (`google_excluded_calendars` テーブル at connection_id 単位) を付与する。
//
//   除外設定 UI (settings.vue) のチェックボックス描画に使う。
//   - `connection_id` クエリは必須。指定された接続が当該 user のものでない /
//     既に切断済みの場合は 404 を返す (情報漏洩を避けるため `409 not connected`
//     とは別扱いにする)。
//   - access_token は withFreshAccessTokenByConnectionId 経由で取り、401 を
//     1 回だけ refresh してリトライする (Issue #75 / Phase 4 と同方針)。
// =============================================================================
import {
  googleCalendarListResponseSchema,
  googleCalendarsRequestSchema,
  googleCalendarsResponseSchema,
  type GoogleCalendarItem,
} from "../../../../shared/schemas";
import { requireUserId } from "../../../utils/auth";
import {
  OauthUnauthorizedError,
  ServiceNotConnectedError,
  withFreshAccessTokenByConnectionId,
} from "../../../utils/serviceConnection";
import { getSupabaseAdmin } from "../../../utils/supabaseAdmin";
import { parseExternal, parseOrThrow } from "../../../utils/validation";

const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

interface RawCalendar {
  id: string;
  name: string | null;
  primary: boolean;
}

async function fetchCalendarList(accessToken: string): Promise<RawCalendar[]> {
  const out: RawCalendar[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList`);
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (res.status === 401) {
      throw new OauthUnauthorizedError("google");
    }
    if (!res.ok) {
      throw createError({
        statusCode: 502,
        statusMessage: `Google calendarList.list failed: HTTP ${res.status}`,
      });
    }
    const json: unknown = await res.json();
    const parsed = parseExternal(googleCalendarListResponseSchema, json, "google");
    for (const item of parsed.items) {
      if (item.deleted) continue;
      out.push({
        id: item.id,
        name: item.summaryOverride ?? item.summary ?? null,
        primary: item.primary === true,
      });
    }
    pageToken = parsed.nextPageToken;
  } while (pageToken);

  return out;
}

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const { connection_id: connectionId } = parseOrThrow(
    googleCalendarsRequestSchema,
    getQuery(event)
  );
  const admin = getSupabaseAdmin();

  // 接続行が「当該 user 所有 / google プロバイダ」であることを admin client
  // で確認する (RLS バイパス経路なので明示チェック)。見つからなければ 404。
  const { data: connRow, error: connErr } = await admin
    .from("service_connections")
    .select("id")
    .eq("id", connectionId)
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();
  if (connErr) {
    throw createError({
      statusCode: 500,
      statusMessage: `failed to load connection: ${connErr.message}`,
    });
  }
  if (!connRow) {
    throw createError({
      statusCode: 404,
      statusMessage: "google connection not found",
    });
  }

  // 接続単位の除外設定を読む (Issue #131 Phase 5)。
  const { data: excludedRows, error: excludedErr } = await admin
    .from("google_excluded_calendars")
    .select("calendar_id")
    .eq("user_id", userId)
    .eq("connection_id", connectionId);
  if (excludedErr) {
    throw createError({
      statusCode: 500,
      statusMessage: `failed to load excluded calendars: ${excludedErr.message}`,
    });
  }
  const excludedSet = new Set<string>(
    (excludedRows ?? []).map((r) => (r as { calendar_id: string }).calendar_id)
  );

  let calendars: RawCalendar[];
  try {
    calendars = await withFreshAccessTokenByConnectionId(connectionId, (accessToken) =>
      fetchCalendarList(accessToken)
    );
  } catch (e) {
    if (e instanceof ServiceNotConnectedError) {
      throw createError({
        statusCode: 409,
        statusMessage: "google is not connected",
      });
    }
    throw e;
  }

  const items: GoogleCalendarItem[] = calendars.map((c) => ({
    id: c.id,
    name: c.name,
    primary: c.primary,
    excluded: excludedSet.has(c.id),
  }));

  return parseOrThrow(googleCalendarsResponseSchema, {
    connection_id: connectionId,
    calendars: items,
  });
});
