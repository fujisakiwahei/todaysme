// =============================================================================
// API エラーレスポンス共通スキーマ
// SPEC §9.2: 部分失敗を許容し、失敗したサービス名とエラー内容を返す
// =============================================================================
import { z } from "zod";

import { serviceProviderSchema } from "./common";

export const apiErrorItemSchema = z.object({
  service: serviceProviderSchema,
  message: z.string(),
});

export const apiErrorResponseSchema = z.object({
  errors: z.array(apiErrorItemSchema),
});

export type ApiErrorItem = z.infer<typeof apiErrorItemSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
