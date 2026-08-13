<script setup lang="ts">
// =============================================================================
// /demo/daily/[date]
// SPEC §5 / §11.4 / Issue #31
//
//   - デモ専用テーブル (demo_*) から読んだ日次詳細をログイン不要で見せる
//     公開デモページ。
//   - 表示は /daily/[date] と同じ DailySummaryView を使い回し、データ取得は
//     /api/demo/summary に向ける。
//   - デモには手動 refresh と stale 判定 / 同期ステータスは無い。
// =============================================================================
import { isoDateSchema, type SummaryResponse } from "~~/shared/schemas";

// 認証は不要。auth middleware を付けない。
definePageMeta({});

const route = useRoute();
const dateParam = computed(() => route.params.date as string);

// 形式 (YYYY-MM-DD) と日付の妥当性を検証する。
if (!isoDateSchema.safeParse(dateParam.value).success) {
  throw createError({
    statusCode: 400,
    statusMessage: "invalid date (expected real YYYY-MM-DD)",
  });
}

const summary = ref<SummaryResponse | null>(null);
const loading = ref(true);
const errorMessage = ref<string | null>(null);

// /daily/[date] と同様に、連続遷移で古いレスポンスが新しい日付の表示を
// 上書きしないよう連番でガードする。
let activeRequestId = 0;

async function fetchSummary() {
  const reqId = ++activeRequestId;
  loading.value = true;
  errorMessage.value = null;
  try {
    const res = await $fetch<SummaryResponse>("/api/demo/summary", {
      query: { date: dateParam.value },
    });
    if (reqId !== activeRequestId) return;
    summary.value = res;
  } catch (e) {
    if (reqId !== activeRequestId) return;
    const msg = e instanceof Error ? e.message : "failed to load summary";
    errorMessage.value = `デモデータの取得に失敗しました: ${msg}`;
  } finally {
    if (reqId === activeRequestId) {
      loading.value = false;
    }
  }
}

// 日付遷移後の再フェッチは watcher で拾う (immediate: false)。
watch(dateParam, async () => {
  summary.value = null;
  await fetchSummary();
});

onMounted(async () => {
  await fetchSummary();
});
</script>

<template>
  <DailySummaryView
    :summary="summary"
    :loading="loading"
    :error-message="errorMessage"
    :date-param="dateParam"
    base-path="/demo/daily"
    read-only-free-time-notes
  >
    <template #topbar-action>
      <span class="demo-badge" aria-label="デモデータ">DEMO</span>
    </template>
  </DailySummaryView>
</template>

<style lang="scss" scoped>
// DailySummaryView と色トーンを揃えるためのトークンを最小限で再宣言する。
$color-text: #1a1814;
$color-surface: #f2f0ea;
$color-border: #e2dfd6;

.demo-badge {
  padding: 4px 10px;
  font-family: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: $color-text;
  background: $color-surface;
  border: 1px solid $color-border;
  border-radius: 999px;
}
</style>
