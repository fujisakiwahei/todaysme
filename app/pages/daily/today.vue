<script setup lang="ts">
// =============================================================================
// /daily/today
// SPEC §5 / §10.2 / Issue #34 / Issue #116 / Issue #189
//
//   - 当日の /daily/[date] を date 指定なしで素早く開くためのエイリアス。
//   - 「今日」は純粋なカレンダー日付ではなく、最新の起床 (wake_at) を起点に
//     決まる起床日 (= SPEC の target_date)。日が回ってもまだ寝ていなければ
//     前回起床日を表示する (Issue #116)。
//   - Oura 側に今朝の起床が登録されていても、まだ refresh が走っていないと
//     DB の最新 wake_at が前日朝のままになり、/daily/[昨日] へ遷移してしまう
//     (Issue #189)。これを防ぐため、遷移前に「カレンダー今日」の sync_status
//     を見て、いずれかの last_synced_at が 30 分以上前 (または記録なし) なら
//     先に /api/summary/refresh を await し、最新の wake_at を取り直してから
//     navigate する。
//   - タイムゾーンは users.timezone (RLS で本人行のみ読める) から取得する。
//   - users 行は signup trigger で作成される前提のため、欠落時は黙って fallback
//     せず明示的に 500 を投げる (summary.get.ts と同じ方針)。
// =============================================================================
import { fetchWakeBasedToday, targetDateInTimezone } from "~/utils/wakeBasedToday";

definePageMeta({
  middleware: ["auth", "require-connections"],
});

const supabase = useSupabaseClient();
const user = useSupabaseUser();
// supabase.from() の await を跨ぐと Nuxt 非同期コンテキストが失われ、
// 後続の navigateTo (内部で useRouter) が 500 を投げる。runWithContext で再注入する。
const nuxtApp = useNuxtApp();
// SSR から /api/summary/refresh を $fetch する際は cookie を明示転送する必要が
// ある (Nuxt は internal $fetch にリクエスト cookie を自動転送しないため)。
// クライアントでは useRequestHeaders は空オブジェクトを返し、ブラウザが同一
// オリジン cookie を自動付与するので、両モードで安全に動く ([date].vue と同じ流儀)。
const requestHeaders = useRequestHeaders(["cookie"]);

const STALE_MS = 30 * 60 * 1000;

async function loadTimezone(userId: string): Promise<string> {
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
  return data.timezone;
}

// 「カレンダー今日」分の daily_sync_statuses を見て stale 判定する。
// wake-based の target_date ではなく **カレンダー今日** を使うのは、
// 「今朝の起床が Oura にはあるが DB に未反映」ケースで wake-based target_date
// が前日朝のままになり、その日の sync_statuses だけ見ると古い情報で判定して
// しまうため (Issue #189 そのもの)。新しい Oura wake_at は「カレンダー今日」分の
// sync で取りに行く実装なので、stale 判定もそちらに合わせる。
//
// stale = いずれかの行で last_synced_at が空 or 30 分以上前 / 行が 1 件もなし。
async function isCalendarTodayStale(userId: string, calendarToday: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("daily_sync_statuses")
    .select("last_synced_at")
    .eq("user_id", userId)
    .eq("target_date", calendarToday);
  // 取れなかった場合は安全側に倒して refresh を走らせる。
  if (error) return true;
  const rows = (data ?? []) as Array<{ last_synced_at: string | null }>;
  if (rows.length === 0) return true;
  const t = Date.now();
  return rows.some((r) => {
    if (!r.last_synced_at) return true;
    return t - new Date(r.last_synced_at).getTime() > STALE_MS;
  });
}

async function refreshCalendarToday(calendarToday: string): Promise<void> {
  // 失敗してもユーザー操作は止めない。stale なまま /daily/[date] へ進む
  // ([date].vue 側の保険 background refresh が再度試みる)。
  try {
    await $fetch("/api/summary/refresh", {
      method: "POST",
      headers: requestHeaders,
      body: { date: calendarToday },
    });
  } catch {
    // noop
  }
}

async function redirectToToday() {
  // @nuxtjs/supabase v2 では useSupabaseUser() が JWT claims を返すため、
  // user id は `sub` クレームから取る (User オブジェクトの `id` ではない)。
  const userId = user.value?.sub;
  // user 未確定で .eq("id", undefined) を投げると 400 になるため弾く。
  if (!userId) return;
  const timezone = await loadTimezone(userId);
  const calendarToday = targetDateInTimezone(new Date(), timezone);
  if (await isCalendarTodayStale(userId, calendarToday)) {
    await refreshCalendarToday(calendarToday);
  }
  const today = await fetchWakeBasedToday(supabase, userId, timezone);
  await nuxtApp.runWithContext(() => navigateTo(`/daily/${today}`, { replace: true }));
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
