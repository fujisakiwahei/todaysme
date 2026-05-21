// =============================================================================
// GET /api/connections/google/calendars
// Issue #108
//
//   ユーザーが Google 側で持っている calendarList を返し、各カレンダーが
//   稼働時間集計から除外されているか (users.excluded_google_calendar_ids)
//   を付与する。
//
//   除外設定 UI (settings.vue) のチェックボックス描画に使う。
//   - Google 接続が無い場合は 409 (要再認可) を返す。
//   - access_token は withFreshAccessToken 経由で取り、401 を 1 回だけ refresh
//     してリトライする (Issue #75 と同じ方針)。
// =============================================================================
import {
  googleCalendarListResponseSchema,
  googleCalendarsResponseSchema,
  type GoogleCalendarItem,
} from "../../../../shared/schemas";
import { requireUserId } from "../../../utils/auth";
import {
  OauthUnauthorizedError,
  ServiceNotConnectedError,
  withFreshAccessToken,
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
    const parsed = parseExternal(
      googleCalendarListResponseSchema,
      json,
      "google",
    );
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
  const admin = getSupabaseAdmin();

  // 除外設定をまず読む。Google 未連携でも 409 を返す前にチェックは不要だが、
  // ServiceNotConnectedError の方を優先的に拾うため try の中で順番に呼ぶ。
  const { data: userRow, error: userErr } = await admin
    .from("users")
    .select("excluded_google_calendar_ids")
    .eq("id", userId)
    .maybeSingle();
  if (userErr) {
    throw createError({
      statusCode: 500,
      statusMessage: "failed to load user",
    });
  }
  const excludedIds: string[] = (userRow?.excluded_google_calendar_ids ??
    []) as string[];
  const excludedSet = new Set(excludedIds);

  let calendars: RawCalendar[];
  try {
    calendars = await withFreshAccessToken(userId, "google", (accessToken) =>
      fetchCalendarList(accessToken),
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

  return parseOrThrow(googleCalendarsResponseSchema, { calendars: items });
});
