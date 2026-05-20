// =============================================================================
// POST /api/connections/toggl
// SPEC §3 / §12.1 / Issue #52
//
//   - Toggl は OAuth ではなく、ユーザーが自分の Profile で発行した API token を
//     /settings から直接フォーム入力する。
//   - サーバ側で暗号化して service_connections に保存する。平文はログに出さない。
// =============================================================================
import { togglConnectRequestSchema } from "../../../shared/schemas";
import { requireUserId } from "../../utils/auth";
import { upsertServiceConnection } from "../../utils/serviceConnection";
import { parseOrThrow } from "../../utils/validation";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);

  const raw = await readBody(event);
  const body = parseOrThrow(togglConnectRequestSchema, raw);

  await upsertServiceConnection({
    userId,
    provider: "toggl",
    accessToken: body.api_token,
    // Toggl は API token 1 本だけで refresh 概念がない
    refreshToken: null,
    expiresInSeconds: null,
  });

  return { ok: true };
});
