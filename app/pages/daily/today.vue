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

const { data: timezone } = await useAsyncData(
  () => `daily-today-tz-${user.value?.id ?? "anonymous"}`,
  async () => {
    // user.value が一見 truthy でも hydration 途中で id 未確定の瞬間がある。
    // その状態で .eq("id", undefined) を投げると 400 になるため弾く。
    if (!user.value?.id) return null;
    const { data, error } = await supabase
      .from("users")
      .select("timezone")
      .eq("id", user.value.id)
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
  },
  // user 確立で key が変わった時に自動再 fetch する。
  { watch: [user] },
);

// SSR では user 未確定で timezone が null になり遷移しない。
// クライアントで user が hydrate された後に timezone を取り直して遷移するため
// watch で反応的に navigateTo する。
watch(
  timezone,
  async (tz) => {
    if (!tz) return;
    // en-CA は ISO 形式 (YYYY-MM-DD) で返す。server/utils/wakeRange.ts の
    // targetDateOf と同じ手法でユーザータイムゾーンにおける今日を求める。
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    await navigateTo(`/daily/${today}`, { replace: true });
  },
  { immediate: true },
);
</script>

<template>
  <div />
</template>
