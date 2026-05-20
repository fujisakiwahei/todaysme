// =============================================================================
// GET /api/connections/oura/start
// SPEC §6 / Issue #52
//
//   - 認可開始エンドポイント。client (settings ページ) は fetch で叩いて
//     authorize_url を受け取り、ブラウザを window.location でそこへ飛ばす。
//   - state は HMAC で署名され uid を含む。同時に CSRF 用の nonce cookie を貼る。
// =============================================================================
import { oauthStartResponseSchema } from "../../../../shared/schemas";
import { requireUserId } from "../../../utils/auth";
import { buildOuraAuthorizeUrl } from "../../../utils/oauth/oura";
import { createOauthState } from "../../../utils/oauthState";
import { parseOrThrow } from "../../../utils/validation";

const OURA_STATE_COOKIE = "todaysme_oauth_state_oura";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const { state, nonce, exp } = createOauthState(userId);

  // CSRF 対策: 同じブラウザがコールバックに戻ってきたことを確認するための nonce
  setCookie(event, OURA_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: !import.meta.dev,
    sameSite: "lax",
    path: "/",
    expires: new Date(exp * 1000),
  });

  const authorize_url = buildOuraAuthorizeUrl(state);
  return parseOrThrow(oauthStartResponseSchema, { authorize_url });
});
