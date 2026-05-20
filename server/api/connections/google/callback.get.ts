// =============================================================================
// GET /api/connections/google/callback
// SPEC §6 / Issue #52
// =============================================================================
import { oauthCallbackQuerySchema } from "../../../../shared/schemas";
import { exchangeGoogleCode } from "../../../utils/oauth/google";
import { OauthStateError, verifyOauthState } from "../../../utils/oauthState";
import { upsertServiceConnection } from "../../../utils/serviceConnection";
import { parseOrThrow } from "../../../utils/validation";

const GOOGLE_STATE_COOKIE = "todaysme_oauth_state_google";

function redirectToSettings(
  event: import("h3").H3Event,
  params: Record<string, string>,
) {
  const search = new URLSearchParams(params).toString();
  return sendRedirect(event, `/settings?${search}`, 302);
}

export default defineEventHandler(async (event) => {
  const raw = getQuery(event);
  const query = parseOrThrow(oauthCallbackQuerySchema, raw);

  const nonce = getCookie(event, GOOGLE_STATE_COOKIE) ?? "";
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

  let userId: string;
  try {
    const payload = verifyOauthState(query.state, nonce);
    userId = payload.uid;
  } catch (e) {
    const reason = e instanceof OauthStateError ? e.message : "invalid_state";
    return redirectToSettings(event, { provider: "google", error: reason });
  }

  try {
    const token = await exchangeGoogleCode(query.code);
    await upsertServiceConnection({
      userId,
      provider: "google",
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresInSeconds: token.expires_in ?? null,
      scopes: token.scope ?? null,
    });
  } catch {
    return redirectToSettings(event, {
      provider: "google",
      error: "token_exchange_failed",
    });
  }

  return redirectToSettings(event, { connected: "google" });
});
