// =============================================================================
// service_connections テーブルへの保存ヘルパ
// SPEC §11.2 / §12.1 / Issue #52
//
//   - access_token / refresh_token は AES-256-GCM (server/utils/crypto.ts) で
//     暗号化してから iv / authTag / ciphertext を 1 つの JSON 文字列にして
//     `*_token_encrypted` カラムへ格納する。
//   - 平文トークンはクライアントに返さない / ログに出さない。
// =============================================================================
import type { ServiceProvider } from "../../shared/schemas";

import { encrypt, type EncryptedPayload } from "./crypto";
import { getSupabaseAdmin } from "./supabaseAdmin";

const SERVICE_CONNECTIONS_TABLE = "service_connections";

export interface ServiceConnectionRow {
  id: string;
  user_id: string;
  provider: ServiceProvider;
  status: "connected" | "disconnected" | "error";
  provider_user_id: string | null;
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
  refreshToken?: string | null;
  expiresInSeconds?: number | null;
  scopes?: readonly string[] | string | null;
  providerUserId?: string | null;
}

function packEncrypted(payload: EncryptedPayload): string {
  return JSON.stringify(payload);
}

export async function upsertServiceConnection(
  input: UpsertServiceConnectionInput,
): Promise<void> {
  const admin = getSupabaseAdmin();
  const now = new Date();

  const accessEnc = packEncrypted(encrypt(input.accessToken));
  const refreshEnc =
    input.refreshToken != null && input.refreshToken !== ""
      ? packEncrypted(encrypt(input.refreshToken))
      : null;

  const tokenExpiresAt =
    input.expiresInSeconds != null && input.expiresInSeconds > 0
      ? new Date(now.getTime() + input.expiresInSeconds * 1000).toISOString()
      : null;

  const scopes = Array.isArray(input.scopes)
    ? input.scopes.join(" ")
    : (input.scopes ?? null);

  const { error } = await admin.from(SERVICE_CONNECTIONS_TABLE).upsert(
    {
      user_id: input.userId,
      provider: input.provider,
      status: "connected",
      provider_user_id: input.providerUserId ?? null,
      access_token_encrypted: accessEnc,
      refresh_token_encrypted: refreshEnc,
      token_expires_at: tokenExpiresAt,
      scopes,
      connected_at: now.toISOString(),
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
      "id, user_id, provider, status, provider_user_id, access_token_encrypted, refresh_token_encrypted, token_expires_at, scopes, connected_at, updated_at",
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
