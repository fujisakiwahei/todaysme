// =============================================================================
// OAuth redirect URI 解決 (Issue #100)
//
//   - GOOGLE_REDIRECT_URI / OURA_REDIRECT_URI が設定されていればそれを使う
//     (リバースプロキシ越し等で実際の origin が取れないケース向けの override)。
//   - 未設定の場合は実リクエストの origin から組み立てる。
//     `.env` の URI と OAuth プロバイダ側に登録した URI のズレで発生する
//     redirect_uri_mismatch / invalid_request を防ぐため。
// =============================================================================
import type { H3Event } from "h3";
import process from "node:process";

type Provider = "google" | "oura";

const ENV_KEY: Record<Provider, string> = {
  google: "GOOGLE_REDIRECT_URI",
  oura: "OURA_REDIRECT_URI",
};

export function resolveOauthRedirectUri(
  event: H3Event,
  provider: Provider,
): string {
  const fromEnv = process.env[ENV_KEY[provider]];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const requestUrl = getRequestURL(event);
  return `${requestUrl.origin}/api/connections/${provider}/callback`;
}
