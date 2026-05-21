// =============================================================================
// GET /api/connections/oura/callback
// SPEC §6 / Issue #52
//
//   - Oura が code / error を乗せて飛んでくる。
//   - state を HMAC 検証し、cookie の nonce と突き合わせ、uid を復元する。
//   - 成功 → service_connections に upsert → /settings?connected=oura に redirect。
//   - 失敗 → /settings?error=<理由> に redirect (UX 最低限)。
// =============================================================================
import { oauthCallbackQuerySchema } from "../../../../shared/schemas";
import { exchangeOuraCode } from "../../../utils/oauth/oura";
import { resolveOauthRedirectUri } from "../../../utils/oauth/redirectUri";
import { OauthStateError, verifyOauthState } from "../../../utils/oauthState";
import { upsertServiceConnection } from "../../../utils/serviceConnection";
import { parseOrThrow } from "../../../utils/validation";

const OURA_STATE_COOKIE = "todaysme_oauth_state_oura";

function redirectToSettings(
  event: import("h3").H3Event,
  params: Record<string, string>,
) {
  const search = new URLSearchParams(params).toString();
  return sendRedirect(event, `/settings?${search}`, 302);
}

export default defineEventHandler(async (event) => {
  // クエリは Oura が決めるので緩めに parse (中身は parseOrThrow で検証)
  const raw = getQuery(event);
  const query = parseOrThrow(oauthCallbackQuerySchema, raw);

  const nonce = getCookie(event, OURA_STATE_COOKIE) ?? "";

  // SEC: state 検証を error 分岐より先に行う。エラー応答だけで cookie を
  //      消費させてしまうと、攻撃者が偽の error コールバックを user に踏ま
  //      せることで進行中の OAuth フローを妨害できてしまうため。
  let userId: string;
  try {
    const payload = verifyOauthState(query.state, nonce);
    userId = payload.uid;
  } catch (e) {
    const reason = e instanceof OauthStateError ? e.message : "invalid_state";
    // state 不一致なら cookie は消さずに残す (本物の進行中フローを守る)
    return redirectToSettings(event, { provider: "oura", error: reason });
  }

  // state OK → cookie を使い切る
  deleteCookie(event, OURA_STATE_COOKIE, { path: "/" });

  if (query.error) {
    return redirectToSettings(event, {
      provider: "oura",
      error: query.error,
    });
  }
  if (!query.code) {
    return redirectToSettings(event, {
      provider: "oura",
      error: "missing_code",
    });
  }

  try {
    // start 側と同じロジックで redirect_uri を決める。
    // (token 交換時の redirect_uri は authorize 時と必ず一致させる必要がある)
    const redirectUri = resolveOauthRedirectUri(event, "oura");
    const token = await exchangeOuraCode(query.code, redirectUri);
    await upsertServiceConnection({
      userId,
      provider: "oura",
      accessToken: token.access_token,
      // refresh_token が無ければ undefined のまま渡し、既存の値を保持させる
      refreshToken: token.refresh_token,
      expiresInSeconds: token.expires_in ?? null,
      scopes: token.scope ?? null,
    });
  } catch {
    return redirectToSettings(event, {
      provider: "oura",
      error: "token_exchange_failed",
    });
  }

  return redirectToSettings(event, { connected: "oura" });
});
