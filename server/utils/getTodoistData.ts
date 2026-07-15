// =============================================================================
// Todoist API v1 (unified) から完了タスクを取得し、DB スキーマに合う形へ整形する
// Issue #206
//
//   - 認証: `Authorization: Bearer <api_token>`。ユーザーが Todoist の
//     設定画面で発行した API トークンをそのまま使う (OAuth ではない)。
//   - 取得: `GET /api/v1/tasks/completed/by_completion_date`。
//     since / until (RFC3339, UTC) の範囲に completed_at が入る完了タスクを
//     カーソルページングで全件取得する。Sync API v9 の completed/get_all は
//     非推奨のため使わない。
//   - 検証: shared/schemas/todoist.ts の Zod スキーマを `parseExternal` 経由で
//     適用する。失敗時は 502 を投げる。
//   - 整形: `todoist_completed_tasks` 行に対応する形へ正規化する。
//     繰り返しタスクは同じ task id で複数回完了しうるため、
//     `${task_id}:${completed_at}` の合成キー (todoist_event_key) で
//     「1 回の完了」を一意に識別する。
// =============================================================================
import {
  todoistCompletedTasksResponseSchema,
  todoistProjectsResponseSchema,
  type TodoistProject,
} from "../../shared/schemas";

import { parseExternal } from "./validation";
import { targetDateOf } from "./wakeRange";

const TODOIST_API_BASE = "https://api.todoist.com/api/v1";
// 1 リクエストあたりの最大取得件数 (API v1 の上限は 200)
const TODOIST_PAGE_LIMIT = 200;
// 暴走防止用の上限。3 日ウィンドウの完了タスクが 200 × 50 件を超えることは
// 個人利用では起こり得ないが、next_cursor が想定外の挙動をした際の保険。
const MAX_PAGE_ITERATIONS = 50;

export interface GetTodoistDataOptions {
  apiToken: string;
  // target_date 算出用の IANA timezone (例: "Asia/Tokyo")
  timezone: string;
  // completed_at の取得範囲 (RFC3339, UTC)。since <= completed_at < until。
  sinceIso: string;
  untilIso: string;
}

// `todoist_completed_tasks` 行に対応する正規化済みレコード。
export interface TodoistCompletedTaskRecord {
  todoist_event_key: string;
  todoist_task_id: string;
  content: string | null;
  project_id: string | null;
  project_name: string | null;
  completed_at: string;
  target_date: string;
}

function buildHeaders(apiToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiToken}`,
    Accept: "application/json",
  };
}

export async function getTodoistCompletedTasks(
  options: GetTodoistDataOptions
): Promise<TodoistCompletedTaskRecord[]> {
  if (!options.apiToken) {
    throw new Error("apiToken is required");
  }
  if (!options.timezone) {
    throw new Error("timezone is required");
  }

  // 同一完了イベントの再受信 (ページ境界の重複) を捨てるため Map で持つ。
  const byEventKey = new Map<string, TodoistCompletedTaskRecord>();
  let cursor: string | null = null;

  for (let i = 0; i < MAX_PAGE_ITERATIONS; i++) {
    const url = new URL(`${TODOIST_API_BASE}/tasks/completed/by_completion_date`);
    url.searchParams.set("since", options.sinceIso);
    url.searchParams.set("until", options.untilIso);
    url.searchParams.set("limit", String(TODOIST_PAGE_LIMIT));
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const res = await fetch(url, { headers: buildHeaders(options.apiToken) });
    if (!res.ok) {
      throw new Error(`Todoist API request failed: HTTP ${res.status}`);
    }

    const raw: unknown = await res.json();
    const page = parseExternal(todoistCompletedTasksResponseSchema, raw, "todoist");

    for (const item of page.items) {
      const eventKey = `${item.id}:${item.completed_at}`;
      byEventKey.set(eventKey, {
        todoist_event_key: eventKey,
        todoist_task_id: item.id,
        content: item.content || null,
        project_id: item.project_id ?? null,
        // project_name は別途 /projects から解決する (enrichWithTodoistProjectNames)
        project_name: null,
        completed_at: item.completed_at,
        target_date: targetDateOf(item.completed_at, options.timezone),
      });
    }

    cursor = page.next_cursor ?? null;
    if (!cursor) break;
  }

  return Array.from(byEventKey.values());
}

// ----------------------------------------------------------------------------
// Projects
//   `GET /api/v1/projects` は `{ results, next_cursor }` のカーソルページング。
//   completed task の project_id → project_name を引くために使う。
// ----------------------------------------------------------------------------

export async function getTodoistProjects(apiToken: string): Promise<TodoistProject[]> {
  if (!apiToken) {
    throw new Error("apiToken is required");
  }

  const projects: TodoistProject[] = [];
  let cursor: string | null = null;

  for (let i = 0; i < MAX_PAGE_ITERATIONS; i++) {
    const url = new URL(`${TODOIST_API_BASE}/projects`);
    url.searchParams.set("limit", String(TODOIST_PAGE_LIMIT));
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const res = await fetch(url, { headers: buildHeaders(apiToken) });
    if (!res.ok) {
      throw new Error(`Todoist projects API request failed: HTTP ${res.status}`);
    }

    const raw: unknown = await res.json();
    const page = parseExternal(todoistProjectsResponseSchema, raw, "todoist");
    projects.push(...page.results);

    cursor = page.next_cursor ?? null;
    if (!cursor) break;
  }

  return projects;
}

// project_id -> project_name の Map を組み立てる (Toggl の buildProjectNameMap と同型)。
export function buildTodoistProjectNameMap(projects: TodoistProject[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of projects) {
    if (p.name && p.name.length > 0) {
      map.set(p.id, p.name);
    }
  }
  return map;
}

// completed task の project_id を見て、与えられたマップから名前を解決して埋める。
// 元配列はミューテートせず、新しい配列を返す。
export function enrichWithTodoistProjectNames(
  records: TodoistCompletedTaskRecord[],
  projectNameById: Map<string, string>
): TodoistCompletedTaskRecord[] {
  return records.map((r) => {
    if (r.project_id == null) return r;
    const name = projectNameById.get(r.project_id);
    if (!name) return r;
    return { ...r, project_name: name };
  });
}
