// =============================================================================
// サーバ専用の Supabase 管理クライアント
// SPEC §11.2 / §12.1 / §12.2
//
//   - service_connections は RLS を force しつつ何も policy を貼っていない
//     (= 認可ユーザーからは直接読めない) ので、必ずこの admin client から触る。
//   - クライアント (ブラウザ) には絶対に露出させない。
// =============================================================================
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import process from "node:process";

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NUXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url) throw new Error("NUXT_PUBLIC_SUPABASE_URL is not set");
  if (!secret) throw new Error("SUPABASE_SECRET_KEY is not set");

  cached = createClient(url, secret, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return cached;
}
