// =============================================================================
// Google OAuth2 クライアント (Issue #52)
//
//   - Authorize endpoint : https://accounts.google.com/o/oauth2/v2/auth
//   - Token endpoint     : https://oauth2.googleapis.com/token
//
// SPEC §3: スコープは calendar.events.readonly のみ (最小権限)。
// refresh_token を取るために access_type=offline + prompt=consent を付ける。
//
// redirect_uri は呼び出し側 (route handler) が `resolveOauthRedirectUri` で
// 解決して渡す (Issue #100)。環境変数固定だと OAuth プロバイダ登録値とのズレで
// redirect_uri_mismatch を起こすため、リクエスト origin からも組み立てられる
// ようにする。
// =============================================================================
import process from "node:process";

import { googleTokenResponseSchema } from "../../../shared/schemas";
import { parseExternal } from "../validation";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// SPEC §3: 最小スコープで calendar.events.readonly のみ。
// 追加で calendar.calendarlist.readonly: SPEC §3 の分類ルールに必要な
// calendarList.list (カレンダー一覧 / calendar_name) を引くために必要。
// (events.readonly 単体では calendarList.list が 403 になる)
//
// Issue #131 (Phase 2): openid + email を追加。
//   - openid : token endpoint レスポンスに id_token を含めるための必須スコープ。
//   - email  : id_token に email / email_verified claim を含めるためのスコープ。
//     設定 UI でアカウントを識別表示する用 (account_email)。
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "openid",
  "email",
] as const;

interface GoogleOauthEnv {
  clientId: string;
  clientSecret: string;
}

function loadEnv(): GoogleOauthEnv {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not set");
  if (!clientSecret) throw new Error("GOOGLE_CLIENT_SECRET is not set");
  return { clientId, clientSecret };
}

export interface BuildGoogleAuthorizeUrlOptions {
  // Issue #131 Phase 3: アカウント追加フローでは
  // `prompt=consent select_account` を指定して Google 側のアカウント
  // ピッカーを必ず出す。デフォルト (再認可 / 初回接続) は consent のみ。
  // (consent を外すと Google が refresh_token を返さなくなることがあるため、
  //  少なくとも consent は常に付ける。)
  selectAccount?: boolean;
}

export function buildGoogleAuthorizeUrl(
  state: string,
  redirectUri: string,
  options: BuildGoogleAuthorizeUrlOptions = {},
): string {
  const env = loadEnv();
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("state", state);
  // refresh_token を確実に得るための定型
  url.searchParams.set("access_type", "offline");
  url.searchParams.set(
    "prompt",
    options.selectAccount ? "consent select_account" : "consent",
  );
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

export async function exchangeGoogleCode(code: string, redirectUri: string) {
  const env = loadEnv();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: env.clientId,
    client_secret: env.clientSecret,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Google token exchange failed: HTTP ${res.status}`);
  }
  const json: unknown = await res.json();
  return parseExternal(googleTokenResponseSchema, json, "google");
}

// Issue #75: 既存の refresh_token で access_token を再発行する。
// Google の refresh レスポンスには refresh_token は通常含まれない
// (= スキーマ上 optional)。呼び出し側は undefined のまま渡し、既存の
// refresh_token を保持する責務を負う (upsertServiceConnection の 3 状態)。
export async function refreshGoogleToken(refreshToken: string) {
  const env = loadEnv();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.clientId,
    client_secret: env.clientSecret,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Google token refresh failed: HTTP ${res.status}`);
  }
  const json: unknown = await res.json();
  return parseExternal(googleTokenResponseSchema, json, "google");
}
