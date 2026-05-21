// =============================================================================
// Toggl Track API v9 から time entries を取得し、DB スキーマに合う形へ整形する
// SPEC §3 / §11.2 / Issue #43
//
//   - 認証: Basic Auth。Toggl の規約で username に API token、password に
//     リテラル文字列 "api_token" を渡す (SPEC §3)。
//   - 取得: `GET /me/time_entries`。差分同期のため `since` (UNIX 秒) を渡す。
//     Toggl の仕様で 1 リクエスト 1000 件まで返るので、since を運用して
//     呼び出し側で繰り返し取得する想定。
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

export interface GetTogglDataOptions {
  apiToken: string;
  // target_date 算出用の IANA timezone (例: "Asia/Tokyo")
  timezone: string;
  // 差分取得 watermark。前回の同期完了時刻を渡す想定。未指定なら全件取得。
  since?: Date;
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

export async function getTogglData(
  options: GetTogglDataOptions,
): Promise<TogglTimeEntryRecord[]> {
  if (!options.apiToken) {
    throw new Error("apiToken is required");
  }
  if (!options.timezone) {
    throw new Error("timezone is required");
  }

  const url = new URL(`${TOGGL_API_BASE}/me/time_entries`);
  if (options.since) {
    // Toggl は since を UNIX 秒で受け取る
    const sinceSeconds = Math.floor(options.since.getTime() / 1000);
    url.searchParams.set("since", String(sinceSeconds));
  }

  const res = await fetch(url, {
    headers: {
      Authorization: buildAuthorizationHeader(options.apiToken),
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Toggl API request failed: HTTP ${res.status}`);
  }

  const raw: unknown = await res.json();
  const entries = parseExternal(togglTimeEntriesResponseSchema, raw, "toggl");

  return entries.map((entry) => toRecord(entry, options.timezone));
}
