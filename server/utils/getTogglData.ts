// =============================================================================
// Toggl Track API v9 から time entries を取得し、DB スキーマに合う形へ整形する
// SPEC §3 / §11.2 / Issue #43
//
//   - 認証: Basic Auth。Toggl の規約で username に API token、password に
//     リテラル文字列 "api_token" を渡す (SPEC §3)。
//   - 取得: `GET /me/time_entries`。差分同期のため `since` (UNIX 秒) を渡す。
//     Toggl の仕様で 1 リクエスト 1000 件まで返るため、レスポンスが上限に
//     達した場合は `at` (各エントリの最終更新時刻) を次回 `since` として
//     繰り返し取得し、上限を越える件数も内部でまとめて返す。
//   - 検証: shared/schemas/toggl.ts の Zod スキーマを `parseExternal` 経由で
//     適用する。失敗時は 502 を投げる。
//   - 整形: `toggl_time_entries` 行に対応する形へ正規化する。タイトル単位の
//     集約は表示層の責務だが、`project_id` も保持して返すことで「別プロジェクト
//     / 別 ID は別データ」の判定を後段でできるようにする。
// =============================================================================
import { Buffer } from "node:buffer";

import {
  togglTimeEntriesResponseSchema,
  type TogglTimeEntry,
} from "../../shared/schemas";

import { parseExternal } from "./validation";
import { targetDateOf } from "./wakeRange";

const TOGGL_API_BASE = "https://api.track.toggl.com/api/v9";
// Toggl 規約: password 側は固定文字列 "api_token"、username 側に実際のトークン
const TOGGL_BASIC_AUTH_PASSWORD = "api_token" as const;
// Toggl /me/time_entries は 1 リクエスト 1000 件まで返す
const TOGGL_PAGE_LIMIT = 1000;
// 暴走防止用の上限 (50,000 件 / 1 呼び出し)。MVP の単一ユーザー運用では
// 通常到達しないが、Toggl の `at` が想定外の挙動をした際の保険として置く。
const MAX_PAGE_ITERATIONS = 50;

export interface GetTogglDataOptions {
  apiToken: string;
  // target_date 算出用の IANA timezone (例: "Asia/Tokyo")
  timezone: string;
  // 差分取得 watermark。前回の同期完了時刻を渡す想定。
  // 未指定かつ startDate/endDate も未指定なら全件取得。
  since?: Date;
  // 開始時刻 (entry.start) ベースのウィンドウ取得 (Issue #39)。YYYY-MM-DD。
  // 指定すると Toggl API の `start_date` / `end_date` (start_date inclusive,
  // end_date exclusive) を使い、since (= 修正時刻ベース) ではなく
  // 「期間内に開始したエントリ」を取得する。
  // 両方指定された場合は startDate/endDate が優先される。
  startDate?: string;
  endDate?: string;
}

// `toggl_time_entries` 行に対応する正規化済みレコード。
// `project_id` は DB カラムにはないが、後段の集約 (タイトル別作業時間) で
// 「別プロジェクトは別データ」を区別するために残している。
export interface TogglTimeEntryRecord {
  toggl_entry_id: string;
  title: string | null;
  start_at: string;
  end_at: string | null;
  target_date: string;
  project_id: number | null;
  // Toggl 側で削除されたエントリを呼び出し側でソフトデリート扱いするための情報。
  // `since` ベース取得時に削除通知として返るレコードは server_deleted_at が
  // 非 null になる。`null` なら現存するエントリ。
  server_deleted_at: string | null;
}

function buildAuthorizationHeader(apiToken: string): string {
  const encoded = Buffer.from(
    `${apiToken}:${TOGGL_BASIC_AUTH_PASSWORD}`,
    "utf8",
  ).toString("base64");
  return `Basic ${encoded}`;
}

function toRecord(
  entry: TogglTimeEntry,
  timezone: string,
): TogglTimeEntryRecord {
  return {
    toggl_entry_id: String(entry.id),
    title: entry.description ?? null,
    start_at: entry.start,
    end_at: entry.stop ?? null,
    target_date: targetDateOf(entry.start, timezone),
    project_id: entry.project_id ?? null,
    server_deleted_at: entry.server_deleted_at ?? null,
  };
}

interface FetchPageParams {
  since?: number;
  startDate?: string;
  endDate?: string;
}

async function fetchPage(
  apiToken: string,
  params: FetchPageParams,
): Promise<TogglTimeEntry[]> {
  const url = new URL(`${TOGGL_API_BASE}/me/time_entries`);
  if (params.startDate !== undefined && params.endDate !== undefined) {
    url.searchParams.set("start_date", params.startDate);
    url.searchParams.set("end_date", params.endDate);
  } else if (params.since !== undefined) {
    url.searchParams.set("since", String(params.since));
  }
  // server_deleted_at 等のメタを取得するために meta=true を付与する
  // (Toggl API v9 は meta=true で削除イベントを返すため Issue #39 のソフト
  // デリート判定に必要)。
  url.searchParams.set("meta", "true");

  const res = await fetch(url, {
    headers: {
      Authorization: buildAuthorizationHeader(apiToken),
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Toggl API request failed: HTTP ${res.status}`);
  }

  const raw: unknown = await res.json();
  return parseExternal(togglTimeEntriesResponseSchema, raw, "toggl");
}

export async function getTogglData(
  options: GetTogglDataOptions,
): Promise<TogglTimeEntryRecord[]> {
  if (!options.apiToken) {
    throw new Error("apiToken is required");
  }
  if (!options.timezone) {
    throw new Error("timezone is required");
  }

  // 開始時刻ベースのウィンドウ取得 (Issue #39 の refresh 用)。期間が短いので
  // 1 ページで十分。ページングは since ベースとは設計が異なるため意図的に分岐する。
  if (options.startDate !== undefined && options.endDate !== undefined) {
    const entries = await fetchPage(options.apiToken, {
      startDate: options.startDate,
      endDate: options.endDate,
    });
    return entries.map((e) => toRecord(e, options.timezone));
  }

  // 同一エントリの再受信 (since == max(at) を再送する境界ケース) を捨てる
  const seen = new Set<number>();
  const result: TogglTimeEntryRecord[] = [];
  let sinceSeconds = options.since
    ? Math.floor(options.since.getTime() / 1000)
    : undefined;

  for (let i = 0; i < MAX_PAGE_ITERATIONS; i++) {
    const entries = await fetchPage(options.apiToken, { since: sinceSeconds });

    let maxAtSeconds = sinceSeconds ?? 0;
    let appendedInThisPage = 0;
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      result.push(toRecord(entry, options.timezone));
      appendedInThisPage++;

      const atSeconds = Math.floor(new Date(entry.at).getTime() / 1000);
      if (atSeconds > maxAtSeconds) maxAtSeconds = atSeconds;
    }

    // 上限未満なら次ページは存在しないので終了
    if (entries.length < TOGGL_PAGE_LIMIT) break;
    // カーソルが進まない / 重複ばかりの場合は安全のため打ち切る
    if (appendedInThisPage === 0) break;
    if (sinceSeconds !== undefined && maxAtSeconds <= sinceSeconds) break;

    sinceSeconds = maxAtSeconds;
  }

  return result;
}
