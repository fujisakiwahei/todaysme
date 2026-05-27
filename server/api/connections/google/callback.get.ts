// =============================================================================
// GET /api/connections/google/callback
// SPEC §6 / Issue #52 / #131 (Phase 2)
// =============================================================================
import { oauthCallbackQuerySchema } from "../../../../shared/schemas";
import { exchangeGoogleCode } from "../../../utils/oauth/google";
import { IdTokenVerificationError, verifyGoogleIdToken } from "../../../utils/oauth/idTokenVerify";
import { resolveOauthRedirectUri } from "../../../utils/oauth/redirectUri";
import { OauthStateError, verifyOauthState } from "../../../utils/oauthState";
import { upsertServiceConnection } from "../../../utils/serviceConnection";
import { parseOrThrow } from "../../../utils/validation";

const GOOGLE_STATE_COOKIE = "todaysme_oauth_state_google";

function redirectToSettings(event: import("h3").H3Event, params: Record<string, string>) {
  const search = new URLSearchParams(params).toString();
  return sendRedirect(event, `/settings?${search}`, 302);
}

export default defineEventHandler(async (event) => {
  const raw = getQuery(event);
  const query = parseOrThrow(oauthCallbackQuerySchema, raw);

  const nonce = getCookie(event, GOOGLE_STATE_COOKIE) ?? "";

  // SEC: state 検証を error 分岐より先に行う。エラー応答だけで cookie を
  //      消費させてしまうと、攻撃者が偽の error コールバックを user に踏ま
  //      せることで進行中の OAuth フローを妨害できてしまうため。
  let userId: string;
  try {
    const payload = verifyOauthState(query.state, nonce);
    userId = payload.uid;
  } catch (e) {
    const reason = e instanceof OauthStateError ? e.message : "invalid_state";
    return redirectToSettings(event, { provider: "google", error: reason });
  }

  deleteCookie(event, GOOGLE_STATE_COOKIE, { path: "/" });

  if (query.error) {
    return redirectToSettings(event, {
      provider: "google",
      error: query.error,
    });
  }
  if (!query.code) {
    return redirectToSettings(event, {
      provider: "google",
      error: "missing_code",
    });
  }

  try {
    // start 側と同じロジックで redirect_uri を決める。
    // (token 交換時の redirect_uri は authorize 時と必ず一致させる必要がある)
    const redirectUri = resolveOauthRedirectUri(event, "google");
    const token = await exchangeGoogleCode(query.code, redirectUri);

    // Issue #131 Phase 2: id_token を JWKS で検証して sub / email を取得する。
    // 未検証の claim を provider_user_id に使うとアカウント mis-link に
    // 繋がるため必ず検証する (設計ドラフト §4.2 (2) / Codex review #127 P1)。
    //
    // openid scope を含めて認可しているので id_token は必ず返るはずだが、
    // 念のため欠落しているケースは「再認可してください」に倒す。
    if (!token.id_token) {
      return redirectToSettings(event, {
        provider: "google",
        error: "missing_id_token",
      });
    }

    let claims: Awaited<ReturnType<typeof verifyGoogleIdToken>>;
    try {
      claims = await verifyGoogleIdToken(token.id_token);
    } catch (e) {
      const reason = e instanceof IdTokenVerificationError ? e.reason : "id_token_invalid";
      console.error("[google callback] id_token verification failed", e);
      return redirectToSettings(event, {
        provider: "google",
        error: `id_token_${reason}`,
      });
    }

    await upsertServiceConnection({
      userId,
      provider: "google",
      accessToken: token.access_token,
      // Google は再認可時に refresh_token を返さないことがあるため、
      // undefined のまま渡して既存の refresh_token を保持させる。
      refreshToken: token.refresh_token,
      expiresInSeconds: token.expires_in ?? null,
      scopes: token.scope ?? null,
      providerUserId: claims.sub,
      accountEmail: claims.email,
    });
  } catch {
    return redirectToSettings(event, {
      provider: "google",
      error: "token_exchange_failed",
    });
  }

  return redirectToSettings(event, { connected: "google" });
});
