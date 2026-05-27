// =============================================================================
// Oura API v2 データ取得 (Issue #41 / #75)
// SPEC §3 / §11.2
//
//   - access_token は呼び出し側 (syncOuraForDate) が
//     serviceConnection.ts の withFreshAccessTokenFromRow 経由で渡す。
//     token_expires_at が 5 分以内なら遅延 refresh、401 が返ったら
//     1 回だけ refresh してリトライする (Issue #75)。
//   - 初期 MVP は usercollection/sleep のみ。readiness / 活動量 / daily_* 系は
//     将来 readiness 用フェッチャを足すときにこの util を拡張する想定。
//   - レスポンスは Zod (parseExternal) で検証する。
//   - Rate limit: 5000 req / 5 min。429 を受けたら短く backoff して 1 回だけ
//     retry する。再度 429 ならそのまま 5xx 系として throw し、呼び出し側
//     (daily_sync_statuses) が failed を記録できるようにする。
// =============================================================================
import { ouraSleepResponseSchema, type OuraSleepItem } from "../../shared/schemas";

import { OauthUnauthorizedError } from "./serviceConnection";
import { parseExternal } from "./validation";
import { targetDateOf } from "./wakeRange";

const OURA_API_BASE = "https://api.ouraring.com/v2";
const OURA_SLEEP_URL = `${OURA_API_BASE}/usercollection/sleep`;

// 429 を受けたときの初期 backoff (ms)。1 回だけ retry する。
const RATE_LIMIT_BACKOFF_MS = 1000;
// 念のためのページング上限 (start/end が ±15 日想定なので 5 ページもあれば十分)。
// この上限に達した時点で next_token が残っている場合は OuraPaginationOverflowError を
// throw し、サイレントに件数欠落させない (Codex review)。
const MAX_PAGES = 10;

export interface OuraSleepRow {
  oura_sleep_id: string;
  // ユーザータイムゾーンにおける wake_at の日付 (Issue #24)
  target_date: string;
  // ISO datetime (timezone offset 付き)
  sleep_start_at: string;
  wake_at: string;
  // total_sleep_duration を分換算した値。欠損は null。
  sleep_minutes: number | null;
}

export interface GetOuraDataInput {
  // 呼び出し側 (syncOuraForDate) が withFreshAccessTokenFromRow で取り出して渡す。
  accessToken: string;
  // 取得対象の target_date 範囲 (YYYY-MM-DD, 両端含む)。
  startDate: string;
  endDate: string;
  // IANA タイムゾーン。target_date の計算に使う。
  timezone: string;
  // テスト用差し込み口。本番では使わない。
  fetchImpl?: typeof fetch;
}

export interface GetOuraDataResult {
  sleeps: OuraSleepRow[];
}

export class OuraApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OuraApiError";
    this.status = status;
  }
}

// MAX_PAGES に達してもまだ next_token が残っているときに throw。
// 部分結果を返して downstream で「同期成功」扱いされるのを防ぐ。
export class OuraPaginationOverflowError extends Error {
  constructor(maxPages: number) {
    super(`Oura sleep pagination exceeded ${maxPages} pages; refusing to return partial data`);
    this.name = "OuraPaginationOverflowError";
  }
}

// =============================================================================
// Oura への HTTP 呼び出し
//   - 401 は OauthUnauthorizedError として throw。withFreshAccessToken が
//     これをキャッチして refresh → 再試行する (Issue #75)。
//   - 429 (rate limit) は 1 回だけ短い backoff で retry する。
//   - それ以外の 4xx / 5xx は OuraApiError として throw。
// =============================================================================
async function callOuraSleep(
  accessToken: string,
  params: { start_date: string; end_date: string; next_token?: string },
  fetchImpl: typeof fetch
): Promise<unknown> {
  const url = new URL(OURA_SLEEP_URL);
  url.searchParams.set("start_date", params.start_date);
  url.searchParams.set("end_date", params.end_date);
  if (params.next_token) url.searchParams.set("next_token", params.next_token);

  const attempt = async (): Promise<Response> =>
    fetchImpl(url.toString(), {
      headers: { authorization: `Bearer ${accessToken}` },
    });

  let res = await attempt();
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
    res = await attempt();
  }

  if (res.status === 401) {
    throw new OauthUnauthorizedError("oura");
  }
  if (!res.ok) {
    throw new OuraApiError(res.status, `Oura API request failed: HTTP ${res.status}`);
  }
  return (await res.json()) as unknown;
}

// =============================================================================
// 1 件の Oura sleep を DB 行に整形する
// =============================================================================
function toRow(item: OuraSleepItem, timezone: string): OuraSleepRow {
  const durationSeconds = item.total_sleep_duration ?? null;
  return {
    oura_sleep_id: item.id,
    // Oura は `day` を wake 日として返すが、Issue #24 に従い
    // 念のため bedtime_end からユーザータイムゾーンで計算し直す。
    target_date: targetDateOf(item.bedtime_end, timezone),
    sleep_start_at: item.bedtime_start,
    wake_at: item.bedtime_end,
    sleep_minutes: durationSeconds == null ? null : Math.round(durationSeconds / 60),
  };
}

// =============================================================================
// getOuraData
//   - 指定範囲の Oura sleep を全件取得し、`oura_sleep_records` 形に整形して返す。
//   - access_token の取得 / refresh は呼び出し側
//     (withFreshAccessTokenFromRow) の責務 (Issue #75 / #176)。401 は
//     OauthUnauthorizedError として伝搬し、ラッパで再試行される。
//   - upsert は呼び出し側 (refresh / cron) の責務。
// =============================================================================
export async function getOuraData(input: GetOuraDataInput): Promise<GetOuraDataResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleeps: OuraSleepRow[] = [];
  let nextToken: string | undefined;
  let exhausted = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await callOuraSleep(
      input.accessToken,
      {
        start_date: input.startDate,
        end_date: input.endDate,
        next_token: nextToken,
      },
      fetchImpl
    );
    const parsed = parseExternal(ouraSleepResponseSchema, raw, "oura");
    for (const item of parsed.data) {
      sleeps.push(toRow(item, input.timezone));
    }
    if (!parsed.next_token) {
      exhausted = true;
      break;
    }
    nextToken = parsed.next_token;
  }

  // MAX_PAGES に達したのに next_token が残っている場合は件数欠落の可能性が
  // あるので、部分結果を返さず明示エラーにする (Codex review)。
  if (!exhausted) {
    throw new OuraPaginationOverflowError(MAX_PAGES);
  }

  return { sleeps };
}
