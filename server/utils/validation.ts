// =============================================================================
// Zod スキーマ検証ヘルパ (server 専用)
// SPEC §12.3 / Issue #20 / #54
//
// API ハンドラ・外部 API クライアントから呼び出す共通の parse ラッパ。
// 失敗時は SchemaValidationError を投げる。
//   - statusCode / statusMessage / data を持つ Error なので、Nuxt server route
//     から throw すれば h3 の onError がそのまま JSON にしてくれる。
//   - h3 / Nuxt に直接依存しないため、ユニットテスト / node:test で素直に動く。
// 詳細なエラー内容はクライアントに返さない (path / message のみ)。
// =============================================================================
import type { z, ZodType } from "zod";

export interface ValidationIssue {
  path: PropertyKey[];
  message: string;
}

// Nuxt / h3 の `createError({...})` の戻り値と互換になるよう
// statusCode / statusMessage / data を Error 自身に生やす。
export class SchemaValidationError extends Error {
  statusCode: number;
  statusMessage: string;
  data: { issues: ValidationIssue[] };

  constructor(
    statusCode: number,
    statusMessage: string,
    issues: ValidationIssue[],
  ) {
    super(statusMessage);
    this.name = "SchemaValidationError";
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
    this.data = { issues };
  }
}

interface ParseOptions {
  statusCode?: number;
  statusMessage?: string;
}

export function parseOrThrow<S extends ZodType>(
  schema: S,
  data: unknown,
  options: ParseOptions = {},
): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new SchemaValidationError(
      options.statusCode ?? 400,
      options.statusMessage ?? "ValidationError",
      result.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    );
  }
  return result.data;
}

// 外部 API レスポンスの検証専用 (失敗は 502 Bad Gateway 扱い)
export function parseExternal<S extends ZodType>(
  schema: S,
  data: unknown,
  service: "oura" | "google" | "toggl",
): z.infer<S> {
  return parseOrThrow(schema, data, {
    statusCode: 502,
    statusMessage: `InvalidExternalResponse:${service}`,
  });
}
