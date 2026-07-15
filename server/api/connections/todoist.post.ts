// =============================================================================
// POST /api/connections/todoist
// Issue #206
//
//   - Todoist は OAuth ではなく、ユーザーが Todoist の設定 (連携機能 →
//     API トークン) で発行したトークンを /settings から直接フォーム入力する。
//   - サーバ側で暗号化して service_connections に保存する。平文はログに出さない。
//     (Toggl の /api/connections/toggl と同型)
// =============================================================================
import { todoistConnectRequestSchema } from "../../../shared/schemas";
import { requireUserId } from "../../utils/auth";
import { upsertServiceConnection } from "../../utils/serviceConnection";
import { parseOrThrow } from "../../utils/validation";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);

  const raw = await readBody(event);
  const body = parseOrThrow(todoistConnectRequestSchema, raw);

  await upsertServiceConnection({
    userId,
    provider: "todoist",
    accessToken: body.api_token,
    // Todoist も API token 1 本だけで refresh 概念がない
    refreshToken: null,
    expiresInSeconds: null,
  });

  return { ok: true };
});
