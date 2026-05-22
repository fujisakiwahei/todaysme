// =============================================================================
// DELETE /api/connections/google/[connectionId]/account
// Issue #139
//
//   接続行を物理削除する。soft disconnect (DELETE /api/connections/google/
//   [connectionId]) と違い、行そのものを削除して settings の一覧からも消す。
//   関連 events / excluded_calendars は FK ON DELETE CASCADE で巻き取られる。
//
//   - 当該行が user_id + provider='google' に一致しないと 404。
//   - status の制約は付けない (UI 側で disconnected のときだけ叩く運用)。
// =============================================================================
import { z } from "zod";

import { requireUserId } from "../../../../utils/auth";
import { deleteGoogleConnectionPermanently } from "../../../../utils/serviceConnection";
import { parseOrThrow } from "../../../../utils/validation";

const deleteGoogleAccountParamsSchema = z.object({
  connectionId: z.uuid(),
});

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const params = parseOrThrow(
    deleteGoogleAccountParamsSchema,
    getRouterParams(event),
  );

  const result = await deleteGoogleConnectionPermanently(
    userId,
    params.connectionId,
  );
  if (!result.found) {
    throw createError({
      statusCode: 404,
      statusMessage: "google connection not found",
    });
  }
  return { ok: true };
});
