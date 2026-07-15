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

// PostgreSQL の unique_violation エラーコード。partial unique index に
// 並走 INSERT が衝突した場合に「2nd INSERT を SELECT → UPDATE リトライ」する
// 判定に使う。
const PG_UNIQUE_VIOLATION = "23505";

interface ExistingConnectionRow {
  id: string;
  refresh_token_encrypted: string | null;
  provider_user_id: string | null;
  account_email: string | null;
  scopes: string | null;
  connected_at: string;
}

async function selectExistingConnection(
  userId: string,
  provider: ServiceProvider,
  providerUserId: string | undefined
): Promise<ExistingConnectionRow | null> {
  const admin = getSupabaseAdmin();
  const baseColumns =
    "id, refresh_token_encrypted, provider_user_id, account_email, scopes, connected_at";

  // Issue #131 Phase 1b: Google で providerUserId が確定している場合は
  // (user_id, provider, provider_user_id) の partial unique と整合するよう、
  // sub も一致条件に含める。これにより「アカウント A の再認可コールバックが
  // アカウント B の行を誤って UPDATE してしまう」事故を防ぐ。
  if (provider === "google" && typeof providerUserId === "string") {
    const { data, error } = await admin
      .from(SERVICE_CONNECTIONS_TABLE)
      .select(baseColumns)
      .eq("user_id", userId)
      .eq("provider", provider)
      .eq("provider_user_id", providerUserId)
      .maybeSingle();
    if (error) {
      throw new Error(`failed to read existing service_connection: ${error.message}`);
    }
    if (data) {
      return data as ExistingConnectionRow;
    }

    // Issue #131 Phase 2 過渡期 (Codex review #136 P1):
    // Phase 2 migration までは適用済みだが Phase 1b が未適用の状態では、
    // 旧 Google 接続行は provider_user_id IS NULL のまま status='needs_reauth'
    // で残り、旧 unique(user_id, provider) 制約も生きている。この時 sub 一致
    // で SELECT すると 0 件になり INSERT 経路へ落ちるが、INSERT は旧制約の
    // 23505 を踏んで上に伝播してしまう (= /settings からの再認可で backfill
    // ができず、Phase 1b の前提条件をいつまでも満たせない)。
    //
    // sub 一致行が無い場合に限り、同 user × Google × provider_user_id IS NULL
    // で active 状態 (connected / needs_reauth) の旧行をフォールバックで拾い、
    // UPDATE 経路で sub と account_email を backfill する。disconnected / error
    // 行は意図的に切断 / 失敗した履歴なので触らない (= ここに混ぜると後段の
    // UPDATE で disconnected 行を connected に蘇生させてしまう)。
    const { data: legacy, error: legacyErr } = await admin
      .from(SERVICE_CONNECTIONS_TABLE)
      .select(baseColumns)
      .eq("user_id", userId)
      .eq("provider", provider)
      .is("provider_user_id", null)
      .in("status", ["connected", "needs_reauth"])
      .maybeSingle();
    if (legacyErr) {
      throw new Error(`failed to read legacy service_connection: ${legacyErr.message}`);
    }
    return (legacy ?? null) as ExistingConnectionRow | null;
  }

  const { data, error } = await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .select(baseColumns)
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) {
    throw new Error(`failed to read existing service_connection: ${error.message}`);
  }
  return (data ?? null) as ExistingConnectionRow | null;
}

// Issue #131 Phase 1b: PostgREST の upsert({onConflict}) は partial unique
// index に推論マッチしないため (`42P10`)、explicit な「SELECT → UPDATE or INSERT」
// に書き換える。partial unique index は並走書き込み時の整合性ガードとしてのみ
// 機能させ、アプリ側からは ON CONFLICT 推論に依存しない。
//
// 並走 INSERT 衝突 (2 ブラウザタブ等で再認可コールバックが同時に走ったケース) は
// PostgreSQL の `23505 (unique_violation)` を 1 度だけ拾い、SELECT → UPDATE 経路を
// 再試行する。
export async function upsertServiceConnection(input: UpsertServiceConnectionInput): Promise<void> {
  const providerUserIdHint =
    typeof input.providerUserId === "string" ? input.providerUserId : undefined;

  // 1 回目: SELECT → UPDATE or INSERT
  if (await tryUpsertOnce(input, providerUserIdHint)) {
    return;
  }
  // 2 回目: 並走 INSERT に負けた直後を想定し、SELECT を再実行して UPDATE を狙う。
  // ここでも勝てなかった (= 想定外の状態) なら最後の error を throw する。
  if (await tryUpsertOnce(input, providerUserIdHint)) {
    return;
  }
  throw new Error("failed to upsert service_connections after retry on unique_violation");
}

// 戻り値: true なら成功 (= 完了)。false なら unique_violation に当たって
// リトライ可能と判断した場合。それ以外のエラーは throw する。
async function tryUpsertOnce(
  input: UpsertServiceConnectionInput,
  providerUserIdHint: string | undefined
): Promise<boolean> {
  const admin = getSupabaseAdmin();
  const now = new Date();

  // 既存行は 1 回だけ読む。refresh_token / scopes / provider_user_id /
  // account_email を undefined 保持仕様で扱うのに加え、connected_at は
  // 「初回接続時刻」を保持するため (refresh のたびに上書きされると
  // /api/connections の表示が常に「今接続した」になってしまう)。
  const existing = await selectExistingConnection(input.userId, input.provider, providerUserIdHint);

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
    input.accountEmail === undefined ? (existing?.account_email ?? null) : input.accountEmail;

  if (existing) {
    // UPDATE 経路: 既存行を id で特定して書き換える。WHERE id を使うことで
    // 並走する別アカウントの行を巻き込まない。
    const { error: updateErr } = await admin
      .from(SERVICE_CONNECTIONS_TABLE)
      .update({
        status: "connected",
        provider_user_id: providerUserId,
        account_email: accountEmail,
        access_token_encrypted: accessEnc,
        refresh_token_encrypted: refreshEnc,
        token_expires_at: tokenExpiresAt,
        scopes,
        updated_at: now.toISOString(),
      })
      .eq("id", existing.id);

    if (updateErr) {
      throw new Error(`failed to update service_connections: ${updateErr.message}`);
    }
    return true;
  }

  // INSERT 経路: 新規行を作成。connected_at は now で初期化。
  const { error: insertErr } = await admin.from(SERVICE_CONNECTIONS_TABLE).insert({
    user_id: input.userId,
    provider: input.provider,
    status: "connected",
    provider_user_id: providerUserId,
    account_email: accountEmail,
    access_token_encrypted: accessEnc,
    refresh_token_encrypted: refreshEnc,
    token_expires_at: tokenExpiresAt,
    scopes,
    connected_at: now.toISOString(),
    updated_at: now.toISOString(),
  });

  if (insertErr) {
    // 並走 INSERT で partial unique に当たった場合は 23505。リトライ可能。
    const code = (insertErr as { code?: string }).code;
    if (code === PG_UNIQUE_VIOLATION) {
      return false;
    }
    throw new Error(`failed to insert service_connections: ${insertErr.message}`);
  }
  return true;
}

// Issue #131 Phase 4+: 同一ユーザー × 同一 provider に複数行ありうる
// (現状は Google のみ) ケースで、provider サマリ用に「代表となる 1 行」を
// 決定的に選ぶ。優先順位:
//   1. status: connected > needs_reauth > error > disconnected
//      (= 1 行でも connected があれば「接続済み」を見せる)
//   2. 同 status 内: connected_at 昇順 (古いほど優先)
//      → /api/connections/google/accounts の並びと一致し、UI 上の表示が
//        ふらつかない
//
// /api/connections や /api/internal/connections-required のような
// 「provider あたり 1 行」を返す経路は必ず本関数を通すこと。
// Map にそのまま投げると挿入順 (= 上流 query の並び依存) で結果が
// 非決定的になる (Codex review #136 P2)。
const CONNECTION_STATUS_PRIORITY: Record<ServiceConnectionRow["status"], number> = {
  connected: 0,
  needs_reauth: 1,
  error: 2,
  disconnected: 3,
};

export function pickPrimaryConnectionRow(
  rows: readonly ServiceConnectionRow[],
  provider: ServiceProvider
): ServiceConnectionRow | undefined {
  let best: ServiceConnectionRow | undefined;
  for (const r of rows) {
    if (r.provider !== provider) continue;
    if (!best) {
      best = r;
      continue;
    }
    const sp = CONNECTION_STATUS_PRIORITY[r.status] - CONNECTION_STATUS_PRIORITY[best.status];
    if (sp < 0) {
      best = r;
    } else if (sp === 0 && r.connected_at < best.connected_at) {
      best = r;
    }
  }
  return best;
}

export async function listServiceConnections(userId: string): Promise<ServiceConnectionRow[]> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .select(
      "id, user_id, provider, status, provider_user_id, account_email, access_token_encrypted, refresh_token_encrypted, token_expires_at, scopes, connected_at, updated_at"
    )
    .eq("user_id", userId);

  if (error) {
    throw new Error(`failed to read service_connections: ${error.message}`);
  }
  return (data ?? []) as ServiceConnectionRow[];
}

export async function disconnectServiceConnection(
  userId: string,
  provider: ServiceProvider
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

// Issue #131 Phase 6: 接続行 id 単位でソフト切断する。複数 Google アカウント
// 連携において「アカウント A だけ解除」を実現するための入口。
//
//   - 当該行が user_id + provider='google' に一致しないと 404 を返す
//     (= 他人の接続 id を当てられても情報漏洩しない)。
//   - 行自体は履歴として残し、status='disconnected'、暗号化トークン
//     ペイロードを null 化する。
//   - 同接続に紐づく google_calendar_events をすべてソフトデリート
//     (`is_deleted = true`)。これをやらないと、disconnect 後も summary
//     画面に過去の予定が残り続けて UX 上ノイズになる。FK ON DELETE CASCADE
//     は「行を物理 delete した場合」しか発火しないため、soft disconnect 経路
//     では明示的に events を畳む。
//   - google_excluded_calendars の行は残す。再認可 (= 同じ provider_user_id
//     による update) で同じ connection_id に紐づき直ったとき、ユーザーが
//     以前選んだ除外設定をそのまま復活させる挙動が期待される。
//
// 戻り値は「切断対象の接続が見つかったか」。見つからなければ呼び出し元
// (HTTP route) が 404 を返す責務。
export interface DisconnectByIdResult {
  found: boolean;
}

export async function disconnectGoogleConnectionById(
  userId: string,
  connectionId: string
): Promise<DisconnectByIdResult> {
  const admin = getSupabaseAdmin();

  // 1. 接続行が当該 user の Google 行であることを確認する。RLS バイパス経路
  //    なので明示的にフィルタする。
  const { data: row, error: readErr } = await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .select("id")
    .eq("id", connectionId)
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();
  if (readErr) {
    throw new Error(`failed to read connection: ${readErr.message}`);
  }
  if (!row) {
    return { found: false };
  }

  // 2. service_connections を soft disconnect。
  const nowIso = new Date().toISOString();
  const { error: updErr } = await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .update({
      status: "disconnected",
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expires_at: null,
      updated_at: nowIso,
    })
    .eq("id", connectionId);
  if (updErr) {
    throw new Error(`failed to disconnect connection: ${updErr.message}`);
  }

  // 3. 関連 events を soft delete (summary 表示から消す)。
  const { error: evErr } = await admin
    .from("google_calendar_events")
    .update({ is_deleted: true, updated_at: nowIso })
    .eq("user_id", userId)
    .eq("connection_id", connectionId)
    .eq("is_deleted", false);
  if (evErr) {
    throw new Error(`failed to soft-delete events: ${evErr.message}`);
  }

  return { found: true };
}

// Issue #139: 接続行 id 単位で「アカウントごと削除」する hard delete。
//
//   - 連携解除 (disconnect) では行を残し soft 状態にするだけだが、ユーザーが
//     完全に該当アカウントを Today's ME から取り除きたいケース (= 過去 events も
//     見えないように消し、settings の一覧からも消したい) のための入口。
//   - 連携状態に関わらず物理削除する (前提として settings UI 側で disconnected
//     のときだけ呼ぶ運用を取るが、API 側では status を制約しない)。
//   - 関連する google_calendar_events / google_excluded_calendars は
//     `on delete cascade` (Phase 4 / Phase 5 migration) で自動的に消える。
//   - 戻り値は disconnect 版と同じく { found } のみ。404 判定は呼び出し元責務。
export async function deleteGoogleConnectionPermanently(
  userId: string,
  connectionId: string
): Promise<DisconnectByIdResult> {
  const admin = getSupabaseAdmin();

  const { data: row, error: readErr } = await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .select("id")
    .eq("id", connectionId)
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();
  if (readErr) {
    throw new Error(`failed to read connection: ${readErr.message}`);
  }
  if (!row) {
    return { found: false };
  }

  const { error: delErr } = await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .delete()
    .eq("id", connectionId)
    .eq("user_id", userId)
    .eq("provider", "google");
  if (delErr) {
    throw new Error(`failed to delete connection: ${delErr.message}`);
  }

  return { found: true };
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

// Issue #176: refresh パスから 1 回だけ全件 SELECT する設計で再利用できるよう
// `provider_user_id` / `account_email` も含める。Google の複数アカウント sync
// ループはこの 2 列を見る (旧 GoogleConnectionForSync の置き換え)。
// Oura / Toggl では参照しないがコスト無視できるレベルで一緒に運ぶ。
export interface ServiceConnectionTokenRow {
  id: string;
  provider: ServiceProvider;
  status: "connected" | "disconnected" | "error" | "needs_reauth";
  provider_user_id: string | null;
  account_email: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  // 楽観ロック用。markConnectionError が「読み取り時点から行が動いていない」
  // ことを確認してから status=error に落とすために使う。
  updated_at: string;
}

// loadConnectionForToken* / loadServiceConnectionsForUser で共通の SELECT 列。
// 1 箇所に集約することで「追加で 1 列増やすと他経路だけ漏れる」事故を防ぐ。
const SERVICE_CONNECTION_TOKEN_COLUMNS =
  "id, provider, status, provider_user_id, account_email, access_token_encrypted, refresh_token_encrypted, token_expires_at, updated_at";

// 既存の (user_id, provider) で接続行を 1 件特定する経路。Oura / Toggl
// (= partial unique で 1 行に絞られる) で引き続き使う。
// Google は Phase 4 以降、複数行になりうるため
// loadConnectionForTokenById を使う (本関数を Google で呼ぶと
// `.maybeSingle()` の「多重行」エラーになる)。
async function loadConnectionForToken(
  userId: string,
  provider: ServiceProvider
): Promise<ServiceConnectionTokenRow> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .select(SERVICE_CONNECTION_TOKEN_COLUMNS)
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

// Issue #131 Phase 4: 接続行 id で 1 件特定する経路。Google 複数アカウント
// 対応の sync ループ (syncGoogleForDate) や接続単位の calendarList 取得
// (Phase 5 の calendars.get) から使う。
async function loadConnectionForTokenById(
  connectionId: string
): Promise<ServiceConnectionTokenRow> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .select(SERVICE_CONNECTION_TOKEN_COLUMNS)
    .eq("id", connectionId)
    .maybeSingle();

  if (error) {
    throw new Error(`failed to read service_connections: ${error.message}`);
  }
  if (!data || data.status !== "connected" || !data.access_token_encrypted) {
    // 行が引けない / status が不適合 → 未接続扱い。provider が分からなく
    // ても呼び出し側 (Phase 4 の sync ループ) は接続行 list を持ったうえで
    // ループに入るので、provider は data?.provider にフォールバックで載せる。
    const provider = (data?.provider as ServiceProvider | undefined) ?? "google";
    throw new ServiceNotConnectedError(provider);
  }
  return data as ServiceConnectionTokenRow;
}

// Issue #176: 1 ユーザー × 1 リフレッシュで service_connections を何度も
// 引いていたのを 1 回にまとめるための入口。トークン列まで含めた全行を返す。
//   - 呼び出し側 (runRefresh.ts) はここで取った行を Oura / Google / Toggl の
//     sync 関数に **引数として渡す**。
//   - 401 リトライ経路は従来通り loadConnectionForTokenById で最新行を引き直す。
//   - order: connected_at 昇順。Google 複数アカウント sync ループの決定的順序を
//     維持する (旧 listConnectedGoogleConnections と同じ並び)。
export async function loadServiceConnectionsForUser(
  userId: string
): Promise<ServiceConnectionTokenRow[]> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .select(SERVICE_CONNECTION_TOKEN_COLUMNS)
    .eq("user_id", userId)
    .order("connected_at", { ascending: true });
  if (error) {
    throw new Error(`failed to read service_connections: ${error.message}`);
  }
  return (data ?? []) as ServiceConnectionTokenRow[];
}

// Oura / Toggl 用: 同 provider × status='connected' の行は最大 1 件のはず。
// access_token_encrypted まで揃っている行のみ返し、揃わなければ ServiceNotConnected。
export function pickConnectedRow(
  rows: readonly ServiceConnectionTokenRow[],
  provider: ServiceProvider
): ServiceConnectionTokenRow | undefined {
  for (const row of rows) {
    if (row.provider === provider && row.status === "connected" && row.access_token_encrypted) {
      return row;
    }
  }
  return undefined;
}

// Google 複数アカウント対応用: status='connected' な行をすべて返す。
// access_token_encrypted が欠落している壊れた行は除外する (旧
// listConnectedGoogleConnections は status のみで絞っていたが、後続で
// withFreshAccessTokenFromRow に渡す前提なら早めに弾いた方が安全)。
export function pickConnectedRows(
  rows: readonly ServiceConnectionTokenRow[],
  provider: ServiceProvider
): ServiceConnectionTokenRow[] {
  return rows.filter(
    (row) => row.provider === provider && row.status === "connected" && row.access_token_encrypted
  );
}

// API token 方式 (refresh 概念がない) のプロバイダ。Toggl / Todoist が該当し、
// 期限チェック・refresh・401 リトライの対象から外す (Issue #206)。
function isApiTokenProvider(provider: ServiceProvider): boolean {
  return provider === "toggl" || provider === "todoist";
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

async function markConnectionError(connectionId: string, expectedUpdatedAt: string): Promise<void> {
  // status="error" にすると次回 loadConnectionForToken が ServiceNotConnectedError を
  // 投げるため、settings 画面で再接続を促す導線につながる。
  //
  // 並走する refresh が片方成功・片方失敗するケースで status を error に巻き戻して
  // しまわないよう、楽観ロックとして「読み取り時点の updated_at と一致する場合のみ」
  // 更新する。並走側が既に新しいトークンを書き込んでいれば updated_at が動くので
  // フィルタが一致せず no-op になる。
  //
  // Issue #131 Phase 4: 接続 id で絞ることで、複数 Google アカウントのうち
  // 片方の refresh 失敗が他方の行を巻き込まないようにする。
  const admin = getSupabaseAdmin();
  await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .update({ status: "error", updated_at: new Date().toISOString() })
    .eq("id", connectionId)
    .eq("updated_at", expectedUpdatedAt);
}

async function callProviderRefresh(
  provider: ServiceProvider,
  refreshToken: string
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
  // Toggl / Todoist はそもそも refresh の概念がない (API token 方式)。
  throw new OauthRefreshError(provider, "refresh is not supported");
}

// 期限切れまたは強制リフレッシュ要求時に refresh_token を使って access_token を
// 再発行し、service_connections を更新して新しい access_token を返す。
// 失敗時は service_connections.status を "error" に落としてから OauthRefreshError を throw する。
//
// expectedUpdatedAt は markConnectionError の楽観ロック条件 (読み取り時点から
// 行が変わっていないときのみ status=error にする)。並走 refresh が片方成功・
// 片方失敗するケースで healthy な接続を error 状態に巻き戻さないため。
async function performRefresh(row: ServiceConnectionTokenRow): Promise<string> {
  const {
    id: connectionId,
    provider,
    refresh_token_encrypted: refreshTokenEncrypted,
    updated_at: expectedUpdatedAt,
  } = row;

  if (!refreshTokenEncrypted) {
    await markConnectionError(connectionId, expectedUpdatedAt);
    throw new OauthRefreshError(provider, "no refresh_token stored");
  }

  let refreshTokenPlain: string;
  try {
    refreshTokenPlain = decryptStoredToken(
      refreshTokenEncrypted,
      `${provider} refresh_token_encrypted`
    );
  } catch (e) {
    await markConnectionError(connectionId, expectedUpdatedAt);
    throw new OauthRefreshError(provider, e instanceof Error ? e.message : "decrypt failed");
  }

  let refreshed: Awaited<ReturnType<typeof callProviderRefresh>>;
  try {
    refreshed = await callProviderRefresh(provider, refreshTokenPlain);
  } catch (e) {
    await markConnectionError(connectionId, expectedUpdatedAt);
    throw new OauthRefreshError(provider, e instanceof Error ? e.message : "token endpoint error");
  }

  // Issue #131 Phase 4: 接続 id を指定して直接 UPDATE する。
  // upsertServiceConnection を経由しないことで、複数 Google アカウントが
  // ある状態でも「正しい行」だけを更新できる (upsert は (user_id, provider)
  // で SELECT してしまうため、Google 複数行で多重マッチが起きる)。
  await rotateConnectionTokensById(connectionId, refreshed);

  return refreshed.accessToken;
}

// Issue #131 Phase 4: 接続行 id を直接指定してトークン関連カラムを更新する。
// `upsertServiceConnection` は新規 OAuth (provider_user_id / account_email が
// 確定するケース) 用、こちらは refresh 専用。
async function rotateConnectionTokensById(
  connectionId: string,
  refreshed: Awaited<ReturnType<typeof callProviderRefresh>>
): Promise<void> {
  const admin = getSupabaseAdmin();
  const now = new Date();
  const accessEnc = packEncrypted(encrypt(refreshed.accessToken));

  // 既存の 3 状態仕様: refresh_token / scopes は undefined のとき既存値を保持。
  const refreshEnc =
    refreshed.refreshToken === undefined
      ? undefined
      : refreshed.refreshToken === null || refreshed.refreshToken === ""
        ? null
        : packEncrypted(encrypt(refreshed.refreshToken));

  const tokenExpiresAt =
    refreshed.expiresInSeconds != null && refreshed.expiresInSeconds > 0
      ? new Date(now.getTime() + refreshed.expiresInSeconds * 1000).toISOString()
      : null;

  const update: Record<string, unknown> = {
    status: "connected",
    access_token_encrypted: accessEnc,
    token_expires_at: tokenExpiresAt,
    updated_at: now.toISOString(),
  };
  if (refreshEnc !== undefined) {
    update.refresh_token_encrypted = refreshEnc;
  }
  if (refreshed.scopes !== undefined) {
    update.scopes = refreshed.scopes ?? null;
  }

  const { error } = await admin
    .from(SERVICE_CONNECTIONS_TABLE)
    .update(update)
    .eq("id", connectionId);
  if (error) {
    throw new Error(`failed to rotate service_connection tokens: ${error.message}`);
  }
}

// 期限が切れる前 (もしくは既に切れている) なら refresh、それ以外は復号した
// access_token をそのまま返す。Toggl は API token 方式なので常にそのまま返す。
//
// 同期処理が「直前に」呼ぶ窓口。expires が null (= 期限不明) の場合は事前 refresh を
// せず、access_token をそのまま返す。401 が返ってきたら withFreshAccessToken が
// 強制リフレッシュ → 再試行する責務を負う。
export async function getValidAccessToken(
  userId: string,
  provider: ServiceProvider
): Promise<string> {
  const row = await loadConnectionForToken(userId, provider);
  return getValidAccessTokenFromRow(row);
}

// Issue #131 Phase 4: 接続行 id を指定して有効な access_token を取得する。
// Google の複数アカウント sync ループから呼ぶ。
export async function getValidAccessTokenByConnectionId(connectionId: string): Promise<string> {
  const row = await loadConnectionForTokenById(connectionId);
  return getValidAccessTokenFromRow(row);
}

async function getValidAccessTokenFromRow(row: ServiceConnectionTokenRow): Promise<string> {
  if (isApiTokenProvider(row.provider)) {
    return decryptStoredToken(
      row.access_token_encrypted!,
      `${row.provider} access_token_encrypted`
    );
  }

  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : null;
  const needsRefresh = expiresAt !== null && expiresAt - Date.now() < TOKEN_REFRESH_LEEWAY_MS;

  if (needsRefresh) {
    return performRefresh(row);
  }

  return decryptStoredToken(row.access_token_encrypted!, `${row.provider} access_token_encrypted`);
}

// 401 が来た直後など、保存中の expires に関係なく必ず refresh したいときに使う。
async function forceRefreshAccessToken(row: ServiceConnectionTokenRow): Promise<string> {
  if (isApiTokenProvider(row.provider)) {
    // Toggl / Todoist には refresh が無いので、これ以上できることがない。
    throw new OauthRefreshError(row.provider, "refresh is not supported");
  }
  return performRefresh(row);
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
  fn: (accessToken: string) => Promise<T>
): Promise<T> {
  const row = await loadConnectionForToken(userId, provider);
  return runWithRetry(row, fn);
}

// Issue #131 Phase 4: 接続行 id を指定して fn を回す版。Google の複数アカウント
// sync ループ等から使う。withFreshAccessToken と同じ 401 リトライ挙動。
export async function withFreshAccessTokenByConnectionId<T>(
  connectionId: string,
  fn: (accessToken: string) => Promise<T>
): Promise<T> {
  const row = await loadConnectionForTokenById(connectionId);
  return runWithRetry(row, fn);
}

// Issue #176: 事前取得済みの接続行を直接受け取って fn を回す版。refresh パスで
// service_connections の重複読みを潰すために導入。受け取った row が
// connected & access_token_encrypted 揃いの前提だが、防御的にチェックする。
// 401 リトライ経路では runWithRetry が DB から最新行を引き直すため、ここで
// 受け取った row が refresh で stale になっても整合性は保たれる。
export async function withFreshAccessTokenFromRow<T>(
  row: ServiceConnectionTokenRow,
  fn: (accessToken: string) => Promise<T>
): Promise<T> {
  if (row.status !== "connected" || !row.access_token_encrypted) {
    throw new ServiceNotConnectedError(row.provider);
  }
  return runWithRetry(row, fn);
}

async function runWithRetry<T>(
  row: ServiceConnectionTokenRow,
  fn: (accessToken: string) => Promise<T>
): Promise<T> {
  const initialToken = await getValidAccessTokenFromRow(row);
  try {
    return await fn(initialToken);
  } catch (err) {
    if (
      !(err instanceof OauthUnauthorizedError) ||
      err.provider !== row.provider ||
      isApiTokenProvider(row.provider)
    ) {
      throw err;
    }
    // 強制 refresh のためには「現在の」行をもう一度読む (並走する refresh が
    // 既に更新を入れている可能性があり、その後で再度 refresh するなら
    // 最新の refresh_token_encrypted / updated_at を使うのが正しい)。
    const fresh = await loadConnectionForTokenById(row.id);
    const refreshedToken = await forceRefreshAccessToken(fresh);
    return fn(refreshedToken);
  }
}
