// =============================================================================
// requireConnections middleware (Issue #101)
//
//   /daily/* は Oura と Google Calendar の両方が接続されていることを前提にする。
//   - Oura の起床時刻 (wake_at) が無いと SPEC §4.2 の Wake-based Timeline を
//     成立させられず、Toggl / Google の集計レンジも定義できない。
//   - したがって未接続のままでは利用できないようにし、/settings に強制的に
//     遷移させて連携を促す。バナー表示用に ?require_connections=<csv> を付与する。
//
//   auth middleware より後に並べる前提 (未ログインなら /login に飛ぶ)。
//   接続状況取得自体に失敗した場合は黙って通す: settings 側でエラーを出して
//   再接続できる導線があるため、ここで二重にブロックしない。
//
//   接続状況は cookie 認証の /api/internal/connections-required を使う。
//   - 過去実装では useSupabaseClient().auth.getSession() から取った access_token
//     を Bearer ヘッダに乗せて /api/connections を叩いていたが、SDK が cookie
//     から session を内部状態に復元するタイミングが route middleware より
//     遅いことがあり、token 未取得時に early-return するとガードが擦り抜けて
//     未接続ユーザーが /daily/* を開けてしまっていた (Codex #104)。
//   - cookie ベース認証なら SSR / client navigation のどちらでも確実に通る。
// =============================================================================
import type { ConnectionsRequiredResponse } from "~~/shared/schemas";

export default defineNuxtRouteMiddleware(async (to) => {
  const user = useSupabaseUser();
  // 未ログインは auth middleware が処理する
  if (!user.value?.sub) return;

  let res: ConnectionsRequiredResponse;
  try {
    // SSR では Nuxt が internal call にリクエスト cookie を引き継いでくれる
    // (server $fetch は同一プロセス呼び出し)。client では fetch が同一オリジン
    // cookie を自動付与する。明示的に cookie を渡す必要はない。
    res = await $fetch<ConnectionsRequiredResponse>("/api/internal/connections-required", {
      headers: useRequestHeaders(["cookie"]),
    });
  } catch {
    return;
  }

  if (res.missing.length === 0) return;

  // 既に /settings に居る場合は無限ループ防止のため何もしない
  if (to.path === "/settings") return;

  return navigateTo(
    {
      path: "/settings",
      query: { require_connections: res.missing.join(",") },
    },
    { replace: true }
  );
});
