// =============================================================================
// Todoist API v1 (unified) レスポンススキーマ
// Issue #206
//
//   - `GET /api/v1/tasks/completed/by_completion_date` で「completed_at が
//     since〜until に入る完了タスク」を取得する。レスポンスは
//     `{ items: Task[], next_cursor }` のカーソルページング。
//   - `GET /api/v1/projects` は `{ results: Project[], next_cursor }`。
//     completed task の project_id → name 解決に使う (Toggl の Issue #112 と
//     同じ非正規化方針)。
//   - Sync API v9 の completed/get_all は非推奨のため使わない。
//   - 必要なフィールドだけを抜き出す。未知フィールドは Zod が無視する。
// =============================================================================
import { z } from "zod";

import { isoDateTimeSchema } from "./common";

// 完了タスク 1 件。API v1 の Task オブジェクトのサブセット。
// completed 系エンドポイントの item なので completed_at は必須で扱う。
export const todoistCompletedTaskSchema = z.object({
  // Task id (v1 は英数字文字列)
  id: z.string().min(1),
  content: z.string(),
  project_id: z.string().nullable().optional(),
  // 例: "2026-07-15T04:12:33.000000Z"
  completed_at: isoDateTimeSchema,
});

export const todoistCompletedTasksResponseSchema = z.object({
  items: z.array(todoistCompletedTaskSchema),
  next_cursor: z.string().nullable().optional(),
});

export const todoistProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
});

export const todoistProjectsResponseSchema = z.object({
  results: z.array(todoistProjectSchema),
  next_cursor: z.string().nullable().optional(),
});

export type TodoistCompletedTask = z.infer<typeof todoistCompletedTaskSchema>;
export type TodoistCompletedTasksResponse = z.infer<typeof todoistCompletedTasksResponseSchema>;
export type TodoistProject = z.infer<typeof todoistProjectSchema>;
export type TodoistProjectsResponse = z.infer<typeof todoistProjectsResponseSchema>;
