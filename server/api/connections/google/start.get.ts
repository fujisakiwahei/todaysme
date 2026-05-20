// =============================================================================
// GET /api/connections/google/start
// SPEC §6 / Issue #52
// =============================================================================
import { oauthStartResponseSchema } from "../../../../shared/schemas";
import { requireUserId } from "../../../utils/auth";
import { buildGoogleAuthorizeUrl } from "../../../utils/oauth/google";
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

  const authorize_url = buildGoogleAuthorizeUrl(state);
  return parseOrThrow(oauthStartResponseSchema, { authorize_url });
});
