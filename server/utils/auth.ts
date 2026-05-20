// =============================================================================
// 現在ログイン中のユーザーを解決する server-only ヘルパ
// SPEC §6 / §12.2
//
//   - Supabase Auth が発行した JWT を Authorization ヘッダか sb-access-token
//     cookie から拾い、supabaseAdmin.auth.getUser(jwt) で検証する。
//   - ログイン未実装の状況では 401 を返す。/settings から呼ぶ前提のため、
//     ここで例外を投げると h3 がそのまま JSON でクライアントに返してくれる。
//   - JWT はログに出さない / クライアントには返さない。
// =============================================================================
import type { H3Event } from "h3";
import { createError, getCookie, getRequestHeader } from "h3";

import { getSupabaseAdmin } from "./supabaseAdmin";

const BEARER_PREFIX = "Bearer ";

function extractBearerToken(event: H3Event): string | null {
  const header = getRequestHeader(event, "authorization");
  if (header && header.startsWith(BEARER_PREFIX)) {
    return header.slice(BEARER_PREFIX.length).trim();
  }
  // Supabase JS が cookie storage を使う場合のフォールバック。
  const cookie = getCookie(event, "sb-access-token");
  return cookie ?? null;
}

export async function requireUserId(event: H3Event): Promise<string> {
  const token = extractBearerToken(event);
  if (!token) {
    throw createError({
      statusCode: 401,
      statusMessage: "Unauthorized",
    });
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) {
    throw createError({
      statusCode: 401,
      statusMessage: "Unauthorized",
    });
  }
  return data.user.id;
}
