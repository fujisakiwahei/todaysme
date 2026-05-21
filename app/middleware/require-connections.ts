// =============================================================================
// requireConnections middleware (Issue #101)
//
//   /daily/* は Oura と Google Calendar の両方が接続されていることを前提にする。
//   - Oura の起床時刻 (wake_at) が無いと SPEC §4.2 の Wake-based Timeline を
//     成立させられず、Toggl / Google の集計レンジも定義できない。
//   - したがって未接続のままでは利用できないようにし、/settings に強制的に
//     遷移させて連携を促す。バナー表示用に ?require_connections=1 を付与する。
//
//   auth middleware より後に並べる前提 (未ログインなら /login に飛ぶ)。
//   接続状況取得自体に失敗した場合は黙って通す: settings 側でエラーを出して
//   再接続できる導線があるため、ここで二重にブロックしない。
// =============================================================================
import type {
  ConnectionListResponse,
  ServiceProvider,
} from "~~/shared/schemas";

const REQUIRED_PROVIDERS: ServiceProvider[] = ["oura", "google"];

export default defineNuxtRouteMiddleware(async (to) => {
  const user = useSupabaseUser();
  // 未ログインは auth middleware が処理する
  if (!user.value?.sub) return;

  const supabase = useSupabaseClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return;

  let res: ConnectionListResponse;
  try {
    res = await $fetch<ConnectionListResponse>("/api/connections", {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return;
  }

  const missing = REQUIRED_PROVIDERS.filter(
    (p) =>
      res.connections.find((c) => c.provider === p)?.status !== "connected",
  );
  if (missing.length === 0) return;

  // 既に /settings に居る場合は無限ループ防止のため何もしない
  if (to.path === "/settings") return;

  return navigateTo(
    {
      path: "/settings",
      query: { require_connections: missing.join(",") },
    },
    { replace: true },
  );
});
