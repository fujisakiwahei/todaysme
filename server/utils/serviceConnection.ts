// =============================================================================
// service_connections テーブルへの保存ヘルパ
// SPEC §11.2 / §12.1 / Issue #52 / #75
//
//   - access_token / refresh_token は AES-256-GCM (server/utils/crypto.ts) で
//     暗号化してから iv / authTag / ciphertext を 1 つの JSON 文字列にして
//     `*_token_encrypted` カラムへ格納する。
//   - 平文トークンはクライアントに返さない / ログに出さない。
//   - 同期処理は getValidAccessToken / withFreshAccessToken を介してトークンを
//     取り出す。前者は token_expires_at が 5 分以内なら遅延 refresh、後者は
//     401 を受けたら 1 回だけ refresh してリトライする (Issue #75)。
// =============================================================================
import type { ServiceProvider } from "../../shared/schemas";

import { decrypt, encrypt, type EncryptedPayload } from "./crypto";
import { refreshGoogleToken } from "./oauth/google";
import { refreshOuraToken } from "./oauth/oura";
import { getSupabaseAdmin } from "./supabaseAdmin";

const SERVICE_CONNECTIONS_TABLE = "service_connections";

// access_token を refresh する判定の前倒し幅 (Issue #75)。
// サーバ時刻と Oura/Google の expires のずれを吸収する。
const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000;

export interface ServiceConnectionRow {
  id: string;
  user_id: string;
  provider: ServiceProvider;
  // Issue #131 Phase 2: 'needs_reauth' を追加。Phase 2 migration で sub 未取得の
  // 既存 Google 行を一旦この状態に落とし、ユーザーに再認可を促す。
  status: "connected" | "disconnected" | "error" | "needs_reauth";
  provider_user_id: string | null;
  // Issue #131 Phase 2: id_token の email claim から取った表示用メアド。
  // 設定 UI に「どのアカウントか」を見せる用途のみ。
  account_email: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  scopes: string | null;
  connected_at: string;
  updated_at: string;
}

export interface UpsertServiceConnectionInput {
  userId: string;
  provider: ServiceProvider;
  accessToken: string;
  // refresh_token / scopes / providerUserId / accountEmail は共通で 3 状態を区別する:
  //   - undefined → 既存の DB 値を保持する
  //                 (Google は再認可時に refresh_token を返さない / refresh
  //                 レスポンスに scope が含まれないことがあり、null で
  //                 上書きしてしまうとオフラインアクセスや権限情報が失われる)
  //   - null       → 明示的に null へ上書き (refresh 概念のない Toggl 等)
  //   - string/配列 → 新しい値で上書き
  refreshToken?: string | null;
  expiresInSeconds?: number | null;
  scopes?: readonly string[] | string | null;
  providerUserId?: string | null;
  // Issue #131 Phase 2: id_token の email claim から取った表示用メアド。
  accountEmail?: string | null;
}

function packEncrypted(payload: EncryptedPayload): string {
  return JSON.stringify(payload);
}

export async function upsertServiceConnection(
  input: UpsertServiceConnectionInput,
): Promise<void> {
  const admin = getSupabaseAdmin();
  const now = new Date();

  // 既存行は 1 回だけ読む。refresh_token / scopes / provider_user_id /
  // account_email を undefined 保持仕様で扱うのに加え、connected_at は
  // 「初回接続時刻」を保持するため (refresh のたびに上書きされると
  // /api/connections の表示が常に「今接続した」になってしまう)。
  const { data: existing, error: existingErr } = await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .select(
      "refresh_token_encrypted, provider_user_id, account_email, scopes, connected_at",
    )
    .eq("user_id", input.userId)
    .eq("provider", input.provider)
    .maybeSingle();
  if (existingErr) {
    throw new Error(
      `failed to read existing service_connection: ${existingErr.message}`,
    );
  }

  const accessEnc = packEncrypted(encrypt(input.accessToken));

  let refreshEnc: string | null;
  if (input.refreshToken === undefined) {
    refreshEnc = existing?.refresh_token_encrypted ?? null;
  } else if (input.refreshToken === null || input.refreshToken === "") {
    refreshEnc = null;
  } else {
    refreshEnc = packEncrypted(encrypt(input.refreshToken));
  }

  const tokenExpiresAt =
    input.expiresInSeconds != null && input.expiresInSeconds > 0
      ? new Date(now.getTime() + input.expiresInSeconds * 1000).toISOString()
      : null;

  let scopes: string | null;
  if (input.scopes === undefined) {
    scopes = existing?.scopes ?? null;
  } else if (input.scopes === null) {
    scopes = null;
  } else if (typeof input.scopes === "string") {
    scopes = input.scopes;
  } else {
    scopes = input.scopes.join(" ");
  }

  const providerUserId =
    input.providerUserId === undefined
      ? (existing?.provider_user_id ?? null)
      : input.providerUserId;

  const accountEmail =
    input.accountEmail === undefined
      ? (existing?.account_email ?? null)
      : input.accountEmail;

  const connectedAt = existing?.connected_at ?? now.toISOString();

  const { error } = await admin.from(SERVICE_CONNECTIONS_TABLE).upsert(
    {
      user_id: input.userId,
      provider: input.provider,
      status: "connected",
      provider_user_id: providerUserId,
      account_email: accountEmail,
      access_token_encrypted: accessEnc,
      refresh_token_encrypted: refreshEnc,
      token_expires_at: tokenExpiresAt,
      scopes,
      connected_at: connectedAt,
      updated_at: now.toISOString(),
    },
    { onConflict: "user_id,provider" },
  );

  if (error) {
    throw new Error(`failed to upsert service_connections: ${error.message}`);
  }
}

export async function listServiceConnections(
  userId: string,
): Promise<ServiceConnectionRow[]> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .select(
      "id, user_id, provider, status, provider_user_id, account_email, access_token_encrypted, refresh_token_encrypted, token_expires_at, scopes, connected_at, updated_at",
    )
    .eq("user_id", userId);

  if (error) {
    throw new Error(`failed to read service_connections: ${error.message}`);
  }
  return (data ?? []) as ServiceConnectionRow[];
}

export async function disconnectServiceConnection(
  userId: string,
  provider: ServiceProvider,
): Promise<void> {
  const admin = getSupabaseAdmin();
  // ソフトに切断: status を disconnected に更新し、暗号化トークンを破棄する。
  const { error } = await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .update({
      status: "disconnected",
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("provider", provider);

  if (error) {
    throw new Error(`failed to disconnect ${provider}: ${error.message}`);
  }
}

// =============================================================================
// Issue #75: 遅延型 access_token 再発行
//
// 同期処理は必ず getValidAccessToken (または withFreshAccessToken) を介して
// トークンを取り出す。直接 service_connections を引いて復号するコードを増やさない。
// =============================================================================

// 接続行が存在しない / status != connected / access_token 欠落のとき。
// 呼び出し側は「未接続」として扱い、settings 画面で再接続を促す。
export class ServiceNotConnectedError extends Error {
  provider: ServiceProvider;
  constructor(provider: ServiceProvider) {
    super(`${provider} is not connected for this user`);
    this.name = "ServiceNotConnectedError";
    this.provider = provider;
  }
}

// refresh 試行に失敗 (refresh_token 欠落 / token endpoint がエラーを返す等)。
// この時点で service_connections.status は "error" に更新済み。
export class OauthRefreshError extends Error {
  provider: ServiceProvider;
  constructor(provider: ServiceProvider, message: string) {
    super(`OAuth refresh failed for ${provider}: ${message}`);
    this.name = "OauthRefreshError";
    this.provider = provider;
  }
}

// 外部 API への呼び出しが 401 で返ってきたことを示す。
// 各データ取得モジュール (getOuraData / getGoogleData 等) が 401 を見たら
// これを throw し、withFreshAccessToken がキャッチして refresh → 再試行する。
export class OauthUnauthorizedError extends Error {
  provider: ServiceProvider;
  constructor(provider: ServiceProvider) {
    super(`OAuth access_token for ${provider} returned 401`);
    this.name = "OauthUnauthorizedError";
    this.provider = provider;
  }
}

interface ServiceConnectionTokenRow {
  status: "connected" | "disconnected" | "error" | "needs_reauth";
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  // 楽観ロック用。markConnectionError が「読み取り時点から行が動いていない」
  // ことを確認してから status=error に落とすために使う。
  updated_at: string;
}

async function loadConnectionForToken(
  userId: string,
  provider: ServiceProvider,
): Promise<ServiceConnectionTokenRow> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .select(
      "status, access_token_encrypted, refresh_token_encrypted, token_expires_at, updated_at",
    )
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();

  if (error) {
    throw new Error(`failed to read service_connections: ${error.message}`);
  }
  if (!data || data.status !== "connected" || !data.access_token_encrypted) {
    throw new ServiceNotConnectedError(provider);
  }
  return data as ServiceConnectionTokenRow;
}

function decryptStoredToken(packed: string, label: string): string {
  let payload: EncryptedPayload;
  try {
    payload = JSON.parse(packed) as EncryptedPayload;
  } catch {
    throw new Error(`malformed ${label} in DB`);
  }
  return decrypt(payload);
}

async function markConnectionError(
  userId: string,
  provider: ServiceProvider,
  expectedUpdatedAt: string,
): Promise<void> {
  // status="error" にすると次回 loadConnectionForToken が ServiceNotConnectedError を
  // 投げるため、settings 画面で再接続を促す導線につながる。
  //
  // 並走する refresh が片方成功・片方失敗するケースで status を error に巻き戻して
  // しまわないよう、楽観ロックとして「読み取り時点の updated_at と一致する場合のみ」
  // 更新する。並走側が既に新しいトークンを書き込んでいれば updated_at が動くので
  // フィルタが一致せず no-op になる。
  const admin = getSupabaseAdmin();
  await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .update({ status: "error", updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("provider", provider)
    .eq("updated_at", expectedUpdatedAt);
}

async function callProviderRefresh(
  provider: ServiceProvider,
  refreshToken: string,
): Promise<{
  accessToken: string;
  refreshToken: string | undefined;
  expiresInSeconds: number | null;
  // scope が返らない場合は undefined のまま流し、upsertServiceConnection の
  // 3 状態仕様で既存スコープを保持する (null で上書きすると権限調査用の
  // 履歴が消える)。
  scopes: string | undefined;
}> {
  if (provider === "oura") {
    const token = await refreshOuraToken(refreshToken);
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresInSeconds: token.expires_in ?? null,
      scopes: token.scope,
    };
  }
  if (provider === "google") {
    const token = await refreshGoogleToken(refreshToken);
    return {
      accessToken: token.access_token,
      // Google は通常 refresh_token を返さないので undefined のまま渡し、
      // upsertServiceConnection の 3 状態仕様で既存値を保持する。
      refreshToken: token.refresh_token,
      expiresInSeconds: token.expires_in ?? null,
      scopes: token.scope,
    };
  }
  // Toggl はそもそも refresh の概念がない (API token 方式)。
  throw new OauthRefreshError(provider, "refresh is not supported");
}

// 期限切れまたは強制リフレッシュ要求時に refresh_token を使って access_token を
// 再発行し、service_connections を更新して新しい access_token を返す。
// 失敗時は service_connections.status を "error" に落としてから OauthRefreshError を throw する。
//
// expectedUpdatedAt は markConnectionError の楽観ロック条件 (読み取り時点から
// 行が変わっていないときのみ status=error にする)。並走 refresh が片方成功・
// 片方失敗するケースで healthy な接続を error 状態に巻き戻さないため。
async function performRefresh(
  userId: string,
  provider: ServiceProvider,
  refreshTokenEncrypted: string | null,
  expectedUpdatedAt: string,
): Promise<string> {
  if (!refreshTokenEncrypted) {
    await markConnectionError(userId, provider, expectedUpdatedAt);
    throw new OauthRefreshError(provider, "no refresh_token stored");
  }

  let refreshTokenPlain: string;
  try {
    refreshTokenPlain = decryptStoredToken(
      refreshTokenEncrypted,
      `${provider} refresh_token_encrypted`,
    );
  } catch (e) {
    await markConnectionError(userId, provider, expectedUpdatedAt);
    throw new OauthRefreshError(
      provider,
      e instanceof Error ? e.message : "decrypt failed",
    );
  }

  let refreshed: Awaited<ReturnType<typeof callProviderRefresh>>;
  try {
    refreshed = await callProviderRefresh(provider, refreshTokenPlain);
  } catch (e) {
    await markConnectionError(userId, provider, expectedUpdatedAt);
    throw new OauthRefreshError(
      provider,
      e instanceof Error ? e.message : "token endpoint error",
    );
  }

  await upsertServiceConnection({
    userId,
    provider,
    accessToken: refreshed.accessToken,
    // 既存の 3 状態仕様: undefined のまま渡せば DB 側の refresh_token を保持。
    refreshToken: refreshed.refreshToken,
    expiresInSeconds: refreshed.expiresInSeconds,
    scopes: refreshed.scopes,
  });

  return refreshed.accessToken;
}

// 期限が切れる前 (もしくは既に切れている) なら refresh、それ以外は復号した
// access_token をそのまま返す。Toggl は API token 方式なので常にそのまま返す。
//
// 同期処理が「直前に」呼ぶ窓口。expires が null (= 期限不明) の場合は事前 refresh を
// せず、access_token をそのまま返す。401 が返ってきたら withFreshAccessToken が
// 強制リフレッシュ → 再試行する責務を負う。
export async function getValidAccessToken(
  userId: string,
  provider: ServiceProvider,
): Promise<string> {
  const row = await loadConnectionForToken(userId, provider);

  if (provider === "toggl") {
    return decryptStoredToken(
      row.access_token_encrypted!,
      "toggl access_token_encrypted",
    );
  }

  const expiresAt = row.token_expires_at
    ? new Date(row.token_expires_at).getTime()
    : null;
  const needsRefresh =
    expiresAt !== null && expiresAt - Date.now() < TOKEN_REFRESH_LEEWAY_MS;

  if (needsRefresh) {
    return performRefresh(
      userId,
      provider,
      row.refresh_token_encrypted,
      row.updated_at,
    );
  }

  return decryptStoredToken(
    row.access_token_encrypted!,
    `${provider} access_token_encrypted`,
  );
}

// 401 が来た直後など、保存中の expires に関係なく必ず refresh したいときに使う。
async function forceRefreshAccessToken(
  userId: string,
  provider: ServiceProvider,
): Promise<string> {
  if (provider === "toggl") {
    // Toggl には refresh が無いので、これ以上できることがない。
    throw new OauthRefreshError(provider, "refresh is not supported");
  }
  const row = await loadConnectionForToken(userId, provider);
  return performRefresh(
    userId,
    provider,
    row.refresh_token_encrypted,
    row.updated_at,
  );
}

// 401 リトライラッパ (Issue #75)。
//   1. getValidAccessToken でトークンを取得
//   2. fn(accessToken) を実行
//   3. fn が OauthUnauthorizedError を投げたら、強制 refresh して 1 回だけ再実行
// 2 回目も 401 ならそのまま OauthUnauthorizedError を伝搬させる。
// Toggl は refresh ができないので 1 回目で失敗したらそのまま投げ返す。
export async function withFreshAccessToken<T>(
  userId: string,
  provider: ServiceProvider,
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  const initialToken = await getValidAccessToken(userId, provider);
  try {
    return await fn(initialToken);
  } catch (err) {
    if (
      !(err instanceof OauthUnauthorizedError) ||
      err.provider !== provider ||
      provider === "toggl"
    ) {
      throw err;
    }
    const refreshedToken = await forceRefreshAccessToken(userId, provider);
    return fn(refreshedToken);
  }
}
