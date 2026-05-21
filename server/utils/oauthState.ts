// =============================================================================
// OAuth 2.0 の state パラメータを HMAC で署名・検証する
// SPEC §6 / §12.1 / Issue #52
//
//   - state には { uid, nonce, exp } を載せる。
//     - uid : 現在ログイン中のユーザー ID。callback で連携先を引き当てるため。
//     - nonce: CSRF 対策 (cookie と突き合わせる)
//     - exp  : Unix 秒。短命 (10 分) にして使い回しを禁ずる。
//   - 署名は HMAC-SHA256(OAUTH_STATE_SECRET, payload)。
//   - 鍵が未設定なら TOKEN_ENCRYPTION_KEY を派生鍵として流用する。
// =============================================================================
import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import process from "node:process";

const SIGN_ALGO = "sha256";
const DEFAULT_TTL_SECONDS = 10 * 60;

export interface OauthStatePayload {
  uid: string;
  nonce: string;
  exp: number;
}

function loadSecret(): Buffer {
  const explicit = process.env.OAUTH_STATE_SECRET;
  if (explicit) return Buffer.from(explicit, "utf8");

  // フォールバック: TOKEN_ENCRYPTION_KEY (base64 32 bytes) を派生鍵として流用。
  // この鍵自体は AES-GCM 用だが、HMAC 鍵としては独立した目的で扱うため
  // 別のラベルで HMAC をかけて分離する。
  const fallback = process.env.TOKEN_ENCRYPTION_KEY;
  if (!fallback) {
    throw new Error(
      "OAUTH_STATE_SECRET (or TOKEN_ENCRYPTION_KEY fallback) is not set",
    );
  }
  return createHmac(SIGN_ALGO, Buffer.from(fallback, "base64"))
    .update("todaysme:oauth-state:v1")
    .digest();
}

function base64UrlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string): string {
  const secret = loadSecret();
  return base64UrlEncode(
    createHmac(SIGN_ALGO, secret).update(payload).digest(),
  );
}

export function createOauthState(
  uid: string,
  options: { ttlSeconds?: number } = {},
): { state: string; nonce: string; exp: number } {
  const exp =
    Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const nonce = randomBytes(16).toString("hex");
  const payload: OauthStatePayload = { uid, nonce, exp };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const sig = sign(encoded);
  return { state: `${encoded}.${sig}`, nonce, exp };
}

export class OauthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OauthStateError";
  }
}

export function verifyOauthState(
  state: string,
  expectedNonce: string,
): OauthStatePayload {
  const dot = state.indexOf(".");
  if (dot === -1) throw new OauthStateError("malformed state");
  const encoded = state.slice(0, dot);
  const sig = state.slice(dot + 1);

  const expected = sign(encoded);
  const a = base64UrlDecode(sig);
  const b = base64UrlDecode(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new OauthStateError("invalid signature");
  }

  let payload: OauthStatePayload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded).toString("utf8"));
  } catch {
    throw new OauthStateError("malformed payload");
  }

  if (
    typeof payload.uid !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new OauthStateError("malformed payload");
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new OauthStateError("expired state");
  }

  // CSRF 対策: cookie に保存しておいた nonce と照合する
  const aN = Buffer.from(payload.nonce, "utf8");
  const bN = Buffer.from(expectedNonce, "utf8");
  if (aN.length !== bN.length || !timingSafeEqual(aN, bN)) {
    throw new OauthStateError("nonce mismatch");
  }

  return payload;
}
