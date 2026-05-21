// 認証必須ページ用の per-route middleware。
// 利用側ページで `definePageMeta({ middleware: ["auth"] })` を指定する。
// 仕様: docs/SPEC.md §5 / §6
export default defineNuxtRouteMiddleware((to) => {
  const user = useSupabaseUser();
  if (user.value) return;

  return navigateTo({
    path: "/login",
    query: { redirect: to.fullPath },
  });
});
