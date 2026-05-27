// =============================================================================
// DELETE /api/connections/google/[connectionId]
// Issue #131 Phase 6
//
//   複数 Google アカウント連携において「接続 1 件だけ」を切断する。
//   旧 `DELETE /api/connections/google` (= provider 単位) は Oura / Toggl
//   との API 互換性のためだけに残るが、settings UI からは本エンドポイント
//   を叩く運用となる。
//
//   - 接続行が当該 user の Google 行でないと 404。
//   - 切断は soft (status='disconnected' + トークン破棄)、関連 events も
//     soft-delete する (詳細は disconnectGoogleConnectionById を参照)。
// =============================================================================
import { z } from "zod";

import { requireUserId } from "../../../utils/auth";
import { disconnectGoogleConnectionById } from "../../../utils/serviceConnection";
import { parseOrThrow } from "../../../utils/validation";

// path param のスキーマは shared/schemas に置くほど他箇所で使い回さないため
// route-local に閉じる。disconnectParamsSchema は provider 用なので別物。
const disconnectGoogleParamsSchema = z.object({
  connectionId: z.uuid(),
});

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const params = parseOrThrow(disconnectGoogleParamsSchema, getRouterParams(event));

  const result = await disconnectGoogleConnectionById(userId, params.connectionId);
  if (!result.found) {
    throw createError({
      statusCode: 404,
      statusMessage: "google connection not found",
    });
  }
  return { ok: true };
});
