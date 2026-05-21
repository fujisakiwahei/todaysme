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
//     集約は表示層の責務。`project_id` は現状 DB スキーマに永続化されないが、
//     将来 (title, project_id) で集約する余地のためにレコード上は保持して返す。
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
  // 差分取得 watermark。前回の同期完了時刻を渡す想定。未指定なら全件取得。
  since?: Date;
}

// `toggl_time_entries` 行に対応する正規化済みレコード。
// `project_id` は DB カラムにはないが、将来同一タイトルを別プロジェクトで
// 区別する集計を入れる場合に備えてレコード上では保持している。
export interface TogglTimeEntryRecord {
  toggl_entry_id: string;
  title: string | null;
  start_at: string;
  end_at: string | null;
  target_date: string;
  project_id: number | null;
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
  };
}

async function fetchPage(
  apiToken: string,
  sinceSeconds: number | undefined,
): Promise<TogglTimeEntry[]> {
  const url = new URL(`${TOGGL_API_BASE}/me/time_entries`);
  if (sinceSeconds !== undefined) {
    url.searchParams.set("since", String(sinceSeconds));
  }

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

  // 同一エントリの再受信 (since == max(at) を再送する境界ケース) を捨てる
  const seen = new Set<number>();
  const result: TogglTimeEntryRecord[] = [];
  let sinceSeconds = options.since
    ? Math.floor(options.since.getTime() / 1000)
    : undefined;

  for (let i = 0; i < MAX_PAGE_ITERATIONS; i++) {
    const entries = await fetchPage(options.apiToken, sinceSeconds);

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
