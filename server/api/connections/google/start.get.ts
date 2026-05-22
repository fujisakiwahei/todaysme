// =============================================================================
// GET /api/connections/google/start
// SPEC §6 / Issue #52 / #131 (Phase 3)
//
//   `?intent=add` を付けて呼ぶと、Google 認可 URL に
//   `prompt=consent select_account` を載せて Google 側のアカウントピッカーを
//   強制表示する。既に接続済みのアカウントを誤って再度押してしまった場合は、
//   callback 側で id_token の sub から既存行を引き当てて UPDATE (= 再認可) に
//   倒れるので「2 アカウント連携」と「単純再認可」のどちらでも安全。
// =============================================================================
import { oauthStartResponseSchema } from "../../../../shared/schemas";
import { requireUserId } from "../../../utils/auth";
import { buildGoogleAuthorizeUrl } from "../../../utils/oauth/google";
import { resolveOauthRedirectUri } from "../../../utils/oauth/redirectUri";
import { createOauthState } from "../../../utils/oauthState";
import { parseOrThrow } from "../../../utils/validation";

const GOOGLE_STATE_COOKIE = "todaysme_oauth_state_google";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const { state, nonce, exp } = createOauthState(userId);

  setCookie(event, GOOGLE_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: !import.meta.dev,
    sameSite: "lax",
    path: "/",
    expires: new Date(exp * 1000),
  });

  // Issue #131 Phase 3: 「別のアカウントを追加」導線では Google 側のピッカーを
  // 強制したいので intent=add を受け付ける。値の集合は将来拡張するかも知れ
  // ないが、当面 'add' のみ判定する。
  const intent = getQuery(event).intent;
  const isAdd = typeof intent === "string" && intent === "add";

  const redirectUri = resolveOauthRedirectUri(event, "google");
  const authorize_url = buildGoogleAuthorizeUrl(state, redirectUri, {
    selectAccount: isAdd,
  });
  return parseOrThrow(oauthStartResponseSchema, { authorize_url });
});
