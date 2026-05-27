// =============================================================================
// Oura OAuth2 クライアント (Issue #52)
//
//   - Authorize endpoint : https://cloud.ouraring.com/oauth/authorize
//   - Token endpoint     : https://api.ouraring.com/oauth/token
//
// SPEC §3 / Issue #11。スコープは MVP で必要な最小限のみ要求する。
//
// redirect_uri は呼び出し側 (route handler) が `resolveOauthRedirectUri` で
// 解決して渡す (Issue #100)。環境変数固定だと OAuth プロバイダ登録値とのズレで
// invalid_request を起こすため、リクエスト origin からも組み立てられる
// ようにする。
// =============================================================================
import process from "node:process";

import { ouraTokenResponseSchema } from "../../../shared/schemas";
import { parseExternal } from "../validation";

const OURA_AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";

// SPEC §4.1: 睡眠 / readiness / 活動量 / 起床時刻 / active calories を読む
export const OURA_SCOPES = ["daily", "personal"] as const;

interface OuraOauthEnv {
  clientId: string;
  clientSecret: string;
}

function loadEnv(): OuraOauthEnv {
  const clientId = process.env.OURA_CLIENT_ID;
  const clientSecret = process.env.OURA_CLIENT_SECRET;
  if (!clientId) throw new Error("OURA_CLIENT_ID is not set");
  if (!clientSecret) throw new Error("OURA_CLIENT_SECRET is not set");
  return { clientId, clientSecret };
}

export function buildOuraAuthorizeUrl(state: string, redirectUri: string): string {
  const env = loadEnv();
  const url = new URL(OURA_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OURA_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeOuraCode(code: string, redirectUri: string) {
  const env = loadEnv();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: env.clientId,
    client_secret: env.clientSecret,
  });

  const res = await fetch(OURA_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    // body にトークンは含まれない想定だが、念のため詳細はサーバログのみに留める。
    throw new Error(`Oura token exchange failed: HTTP ${res.status}`);
  }
  const json: unknown = await res.json();
  return parseExternal(ouraTokenResponseSchema, json, "oura");
}

// Issue #75: 既存の refresh_token で access_token を再発行する。
// レスポンスは exchangeOuraCode と同じ token endpoint なので同じスキーマで検証する。
export async function refreshOuraToken(refreshToken: string) {
  const env = loadEnv();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.clientId,
    client_secret: env.clientSecret,
  });

  const res = await fetch(OURA_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Oura token refresh failed: HTTP ${res.status}`);
  }
  const json: unknown = await res.json();
  return parseExternal(ouraTokenResponseSchema, json, "oura");
}
