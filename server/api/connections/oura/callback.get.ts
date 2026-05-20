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

  // cookie は使い切り
  const nonce = getCookie(event, OURA_STATE_COOKIE) ?? "";
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

  let userId: string;
  try {
    const payload = verifyOauthState(query.state, nonce);
    userId = payload.uid;
  } catch (e) {
    const reason = e instanceof OauthStateError ? e.message : "invalid_state";
    return redirectToSettings(event, { provider: "oura", error: reason });
  }

  try {
    const token = await exchangeOuraCode(query.code);
    await upsertServiceConnection({
      userId,
      provider: "oura",
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
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
