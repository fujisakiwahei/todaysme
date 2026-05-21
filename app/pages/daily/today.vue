<script setup lang="ts">
// =============================================================================
// /daily/today
// SPEC §5 / Issue #34 / Issue #116
//
//   - 当日の /daily/[date] を date 指定なしで素早く開くためのエイリアス。
//   - 「今日」は純粋なカレンダー日付ではなく、最新の起床 (wake_at) を起点に
//     決まる起床日 (= SPEC の target_date)。日が回ってもまだ寝ていなければ
//     前回起床日を表示する (Issue #116)。
//   - タイムゾーンは users.timezone (RLS で本人行のみ読める) から取得する。
//   - users 行は signup trigger で作成される前提のため、欠落時は黙って fallback
//     せず明示的に 500 を投げる (summary.get.ts と同じ方針)。
// =============================================================================
import { fetchWakeBasedToday } from "~/utils/wakeBasedToday";

definePageMeta({
  middleware: ["auth", "require-connections"],
});

const supabase = useSupabaseClient();
const user = useSupabaseUser();
// supabase.from() の await を跨ぐと Nuxt 非同期コンテキストが失われ、
// 後続の navigateTo (内部で useRouter) が 500 を投げる。runWithContext で再注入する。
const nuxtApp = useNuxtApp();

async function redirectToToday() {
  // @nuxtjs/supabase v2 では useSupabaseUser() が JWT claims を返すため、
  // user id は `sub` クレームから取る (User オブジェクトの `id` ではない)。
  const userId = user.value?.sub;
  // user 未確定で .eq("id", undefined) を投げると 400 になるため弾く。
  if (!userId) return;
  const { data, error } = await supabase
    .from("users")
    .select("timezone")
    .eq("id", userId)
    .maybeSingle<{ timezone: string }>();
  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: "failed to load user",
    });
  }
  if (!data) {
    throw createError({
      statusCode: 500,
      statusMessage: "user profile is missing",
    });
  }
  const today = await fetchWakeBasedToday(supabase, userId, data.timezone);
  await nuxtApp.runWithContext(() =>
    navigateTo(`/daily/${today}`, { replace: true }),
  );
}

// SSR とクライアントどちらでも user が確定していれば即座に遷移する。
// navigateTo を watch コールバック (非同期) に入れると SSR レスポンスが
// 先に確定してしまい 302 ではなく 200 + 空 HTML が返るため、setup 直下で await する。
if (user.value?.sub) {
  await redirectToToday();
} else if (import.meta.client) {
  // クライアントで hydration 中に user.value が未確定な瞬間があるため、
  // 確定し次第 navigate する。SSR では到達しないので watch は登録しない。
  const stop = watch(user, async (u) => {
    if (!u?.sub) return;
    stop();
    await redirectToToday();
  });
}
</script>

<template>
  <div />
</template>
