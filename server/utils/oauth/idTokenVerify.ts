// =============================================================================
// Google id_token (OpenID Connect) JWKS 検証ヘルパ
// SPEC §12.1 / Issue #131 (設計ドラフト docs/designs/multi-google-account.md §4.2)
//
// なぜ JWKS で検証するか:
//   token endpoint は HTTPS 直通だが、`id_token` の中身は OAuth 仕様上
//   「クライアントが検証する責務」を持つ。未検証の claim を provider_user_id に
//   使うと、トークンが malformed / 想定外の発行元を指していた場合に
//   アカウント mis-link 〜 不正な行紐付けに繋がる (Codex review #127 P1)。
//
// 検証項目 (設計 §4.2 (2)):
//   - 署名 (RS256, Google JWKS: https://www.googleapis.com/oauth2/v3/certs)
//   - iss = 'https://accounts.google.com' or 'accounts.google.com'
//   - aud = GOOGLE_CLIENT_ID
//   - exp > 現在時刻 / iat の clock skew は 5 分以内
//
// JWKS は短期キャッシュ (10 分) して連続呼び出しを避ける。jose の `createRemoteJWKSet`
// は内部で coalesce / cache を行うため、モジュール内で 1 度だけ生成する。
// =============================================================================
import process from "node:process";

import { createRemoteJWKSet, jwtVerify, errors } from "jose";

const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");
const GOOGLE_ISS_VALUES = [
  "https://accounts.google.com",
  "accounts.google.com",
] as const;
// iat の clock skew 許容幅 (設計 §4.2 (2): 5 分)。
const CLOCK_SKEW_SECONDS = 5 * 60;
// JWKS のキャッシュ TTL。jose のデフォルト挙動でも 10 分程度キャッシュされるが
// 明示的に値を渡しておく。
const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
// 取得タイムアウト。Google JWKS は通常 100-300ms 程度。
const JWKS_TIMEOUT_MS = 5 * 1000;

// モジュールスコープでの 1 度きり初期化。
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!cachedJwks) {
    cachedJwks = createRemoteJWKSet(GOOGLE_JWKS_URL, {
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
      timeoutDuration: JWKS_TIMEOUT_MS,
    });
  }
  return cachedJwks;
}

export interface GoogleIdTokenClaims {
  // OpenID Connect の "subject"。Google アカウントごとに一意で安定。
  // service_connections.provider_user_id にそのまま入れる。
  sub: string;
  // ログイン中のメールアドレス。表示用 (account_email)。
  // Google 側で未取得スコープの場合は欠落しうるので optional 扱い。
  email: string | null;
  // メール確認済みフラグ。未確認のメアドは表示用ラベルとしては許容するが、
  // 念のため呼び出し側で参照できるよう返す。
  email_verified: boolean;
}

export class IdTokenVerificationError extends Error {
  reason: string;
  constructor(reason: string, cause?: unknown) {
    super(`id_token verification failed: ${reason}`);
    this.name = "IdTokenVerificationError";
    this.reason = reason;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

function loadAudience(): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new IdTokenVerificationError("GOOGLE_CLIENT_ID is not set");
  }
  return clientId;
}

// id_token を JWKS で検証し、必須 claim (sub) を返す。
//   - 署名失敗 / iss 不一致 / aud 不一致 / 期限切れ / iat の skew 超過 → throw
//   - email は scope に email が含まれていれば付く想定。欠落しても fail させない
//     (provider_user_id だけあれば「どの Google アカウントか」は確定できるため)。
export async function verifyGoogleIdToken(
  idToken: string,
): Promise<GoogleIdTokenClaims> {
  const audience = loadAudience();

  let verified: Awaited<ReturnType<typeof jwtVerify>>;
  try {
    verified = await jwtVerify(idToken, getJwks(), {
      issuer: [...GOOGLE_ISS_VALUES],
      audience,
      // jose の clockTolerance は string ("5m") or number (秒) を受け付ける。
      // exp チェックにも同じ tolerance が適用される (= 5 分過ぎていても許容)。
      // exp の許容幅は通常 0 にしたいところだが、token endpoint と
      // クライアントサーバ間の時計ずれを 5 分まで許容する仕様 (§4.2 (2))。
      clockTolerance: CLOCK_SKEW_SECONDS,
      // jose は alg を JWKS 側から推論するが、Google は RS256 固定。
      // 明示的に RS256 に限定して、攻撃ベクトル (alg=none 等) を遮断する。
      algorithms: ["RS256"],
    });
  } catch (e) {
    if (e instanceof errors.JOSEError) {
      throw new IdTokenVerificationError(e.code ?? e.name, e);
    }
    throw new IdTokenVerificationError(
      e instanceof Error ? e.message : "unknown verification error",
      e,
    );
  }

  const payload = verified.payload as Record<string, unknown>;

  const sub = payload["sub"];
  if (typeof sub !== "string" || sub.length === 0) {
    throw new IdTokenVerificationError("missing sub claim");
  }

  const emailRaw = payload["email"];
  const email = typeof emailRaw === "string" && emailRaw.length > 0
    ? emailRaw
    : null;

  const emailVerifiedRaw = payload["email_verified"];
  const email_verified = emailVerifiedRaw === true;

  return { sub, email, email_verified };
}
