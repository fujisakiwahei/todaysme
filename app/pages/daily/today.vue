<script setup lang="ts">
// =============================================================================
// /daily/today
// SPEC §5 / Issue #34
//
//   - 当日の /daily/[date] を date 指定なしで素早く開くためのエイリアス。
//   - ユーザータイムゾーン基準で「今日」を解決し、/daily/YYYY-MM-DD に置換遷移する。
//   - タイムゾーンは users.timezone (RLS で本人行のみ読める) から取得する。
//   - users 行は signup trigger で作成される前提のため、欠落時は黙って fallback
//     せず明示的に 500 を投げる (summary.get.ts と同じ方針)。
// =============================================================================

definePageMeta({
  middleware: ["auth"],
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
  // en-CA は ISO 形式 (YYYY-MM-DD) で返す。server/utils/wakeRange.ts の
  // targetDateOf と同じ手法でユーザータイムゾーンにおける今日を求める。
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: data.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
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
