// =============================================================================
// 現在ログイン中のユーザーを解決する server-only ヘルパ
// SPEC §6 / §12.2
//
//   - Supabase Auth が発行した JWT を Authorization: Bearer ヘッダから拾い、
//     supabaseAdmin.auth.getUser(jwt) で検証する。
//   - cookie へのフォールバックは行わない。OAuth start のような mutation を
//     伴うルートを cookie 認証で通すと、第三者のトップレベルナビゲーション
//     (<a target=_top>, <img>, リダイレクト等) からも認証が通り、nonce
//     cookie を上書きされてフロー DoS を引き起こせるため (CSRF)。Bearer
//     ヘッダはクロスオリジン navigation では送られないので CSRF にならない。
//   - ログイン未実装の状況では 401 を返す。/settings から呼ぶ前提のため、
//     ここで例外を投げると h3 がそのまま JSON でクライアントに返してくれる。
//   - JWT はログに出さない / クライアントには返さない。
//   - cookie 認証も許容したい SSR 経由のページ用 (e.g. /daily/[date]) は
//     `requireUserIdAllowCookie` を使う (Issue #141)。
// =============================================================================
import { serverSupabaseUser } from "#supabase/server";
import type { H3Event } from "h3";
import { createError, getRequestHeader } from "h3";

import { getSupabaseAdmin } from "./supabaseAdmin";

const BEARER_PREFIX = "Bearer ";

function extractBearerToken(event: H3Event): string | null {
  const header = getRequestHeader(event, "authorization");
  if (header && header.startsWith(BEARER_PREFIX)) {
    return header.slice(BEARER_PREFIX.length).trim();
  }
  return null;
}

async function resolveBearerUserId(event: H3Event): Promise<string | null> {
  const token = extractBearerToken(event);
  if (!token) return null;
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

export async function requireUserId(event: H3Event): Promise<string> {
  const userId = await resolveBearerUserId(event);
  if (!userId) {
    throw createError({
      statusCode: 401,
      statusMessage: "Unauthorized",
    });
  }
  return userId;
}

// SSR 起点の fetch では Supabase SDK の session token が間に合わず Bearer を
// 載せられない。CSRF 上問題にならないルート (= nonce 等の認証 cookie を
// 書き換えない / 第三者のトップレベル navigation から呼ばれても害が無い)
// だけ、cookie 認証 (serverSupabaseUser) へのフォールバックを許す。
// /api/internal/connections-required と同じ方針 (Codex #104)。
export async function requireUserIdAllowCookie(event: H3Event): Promise<string> {
  const bearerUserId = await resolveBearerUserId(event);
  if (bearerUserId) return bearerUserId;

  const user = await serverSupabaseUser(event);
  const cookieUserId = user?.sub;
  if (!cookieUserId) {
    throw createError({
      statusCode: 401,
      statusMessage: "Unauthorized",
    });
  }
  return cookieUserId;
}
