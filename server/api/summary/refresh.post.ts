// =============================================================================
// POST /api/summary/refresh
// SPEC §9.1 / §9.2 / §10.4 / §11.3 / §12.1 / §12.3 / Issue #39
//
//   - 対象日のデータを Oura / Google / Toggl から再取得し、DB に upsert する。
//   - 実際の sync 処理は `server/utils/runRefresh.ts` に共通化されており、
//     GET /api/cron/daily (Issue #40) と同じロジックを共有する。
//   - 平文の access_token はクライアントに返さない / ログに出さない (SPEC §12.1)。
// =============================================================================
import { summaryRefreshRequestSchema, summaryRefreshResponseSchema } from "../../../shared/schemas";
import { requireUserIdAllowCookie } from "../../utils/auth";
import { refreshUserDate } from "../../utils/runRefresh";
import { parseOrThrow } from "../../utils/validation";

export default defineEventHandler(async (event) => {
  const userId = await requireUserIdAllowCookie(event);
  const raw = await readBody(event);
  const body = parseOrThrow(summaryRefreshRequestSchema, raw);

  const { sync_statuses, errors } = await refreshUserDate(userId, body.date);

  return parseOrThrow(summaryRefreshResponseSchema, {
    target_date: body.date,
    sync_statuses,
    errors: errors.length > 0 ? errors : undefined,
  });
});
