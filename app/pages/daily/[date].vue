<script setup lang="ts">
// =============================================================================
// /daily/[date]
// SPEC §4 / §5 / §9.3 / §10 / Issue #35 / Issue #141
//
//   - GET /api/summary?date=YYYY-MM-DD で対象日の Today's ME と Wake-based
//     Timeline 用データを取得して表示する。
//   - 当日かつ sync_status の last_synced_at が 30 分以上古ければ、表示直後に
//     裏で POST /api/summary/refresh を呼ぶ (SPEC §10.2)。
//   - 手動「更新」ボタンで同じ refresh を呼び、終了後に再フェッチする。
//   - 過去日も手動更新は許容する (SPEC §10.2 / §10.3)。
//   - 描画は DailySummaryView コンポーネントに委譲する (Issue #31)。
//   - 初回取得は useAsyncData で SSR 側に倒し、hydration 待ち / Bearer
//     token 取得 (supabase.auth.getSession) の往復を省略する (Issue #141)。
//     認証は cookie 経路 (`requireUserIdAllowCookie`) に統一。
// =============================================================================
import { isoDateSchema, type SummaryResponse } from "~~/shared/schemas";

definePageMeta({
  middleware: ["auth", "require-connections"],
});

const route = useRoute();
const dateParam = computed(() => route.params.date as string);

// 形式 (YYYY-MM-DD) だけでなく、2026-02-31 のような実在しない日付も弾く。
// isoDateSchema (= z.iso.date()) が意味的な日付妥当性まで検証する。
if (!isoDateSchema.safeParse(dateParam.value).success) {
  throw createError({
    statusCode: 400,
    statusMessage: "invalid date (expected real YYYY-MM-DD)",
  });
}

// SSR では Nuxt の internal $fetch にリクエスト cookie を引き継ぐ必要がある。
// client では useRequestHeaders は空オブジェクトを返し、ブラウザが同一オリジン
// cookie を自動付与するため、どちらのモードでも安全に動く。
// (require-connections middleware と同じ流儀)
function summaryFetchHeaders() {
  return useRequestHeaders(["cookie"]);
}

// key を日付別 (関数形のリアクティブキー) にし、watch オプションで dateParam
// 変更時の再フェッチを Nuxt 公式の経路に任せる (Issue #154)。
//   - 固定 key だと payload キャッシュが日付間で衝突し、SSR ハイドレーション
//     後に dateParam が変わってもハンドラが再実行されないケースがあった。
//   - 自前の watch + refresh() 経路は `_asyncDataPromise` の内部ガードと噛み合
//     わないため捨て、stale チェックは summary 自体の変化を watch する形に変更。
//
// default オプションで初期値を null にして、useAsyncData が型に混ぜてくる
// undefined を消す (DailySummaryView の props は SummaryResponse | null)。
const {
  data: summary,
  pending: loading,
  refresh: refreshSummary,
  error: summaryError,
} = await useAsyncData<SummaryResponse, Error, SummaryResponse | null>(
  () => `daily-summary-${dateParam.value}`,
  () =>
    $fetch<SummaryResponse>("/api/summary", {
      query: { date: dateParam.value },
      headers: summaryFetchHeaders(),
    }),
  { default: () => null, watch: [dateParam] },
);

const refreshing = ref(false);
const manualErrorMessage = ref<string | null>(null);

// useAsyncData が拾ったエラー (= 初回 / 日付遷移時の取得失敗) と、
// 手動更新ボタン由来のエラーを 1 つのバナーに集約する。手動 refresh のメッセージを
// 優先し、消えたら useAsyncData 側の最新エラーへフォールバックする。
const errorMessage = computed<string | null>(() => {
  if (manualErrorMessage.value) return manualErrorMessage.value;
  if (!summaryError.value) return null;
  const msg =
    summaryError.value instanceof Error
      ? summaryError.value.message
      : "failed to load summary";
  return `サマリー取得に失敗しました: ${msg}`;
});

async function manualRefresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  manualErrorMessage.value = null;
  try {
    await $fetch("/api/summary/refresh", {
      method: "POST",
      headers: summaryFetchHeaders(),
      body: { date: dateParam.value },
    });
    await refreshSummary();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to refresh";
    manualErrorMessage.value = `更新に失敗しました: ${msg}`;
  } finally {
    refreshing.value = false;
  }
}

// 当日かつ stale なら裏で refresh する。
// stale 判定 = sync_statuses が空、または last_synced_at が 30 分以上古い。
const STALE_MS = 30 * 60 * 1000;

function isTodayInTimezone(date: string, timezone: string): boolean {
  // ロケール依存の format(...) (例: "en-CA" でも実装によっては M/D/YYYY) を避け、
  // formatToParts から year/month/day を取り出して自前で YYYY-MM-DD を組み立てる。
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const yyyy = parts.find((p) => p.type === "year")?.value;
  const mm = parts.find((p) => p.type === "month")?.value;
  const dd = parts.find((p) => p.type === "day")?.value;
  if (!yyyy || !mm || !dd) return false;
  return `${yyyy}-${mm}-${dd}` === date;
}

function isStale(s: SummaryResponse): boolean {
  if (!isTodayInTimezone(s.target_date, s.timezone)) return false;
  if (s.sync_statuses.length === 0) return true;
  const t = Date.now();
  return s.sync_statuses.some((st) => {
    if (!st.last_synced_at) return true;
    return t - new Date(st.last_synced_at).getTime() > STALE_MS;
  });
}

async function backgroundRefreshIfStale() {
  const current = summary.value;
  if (!current) return;
  // 再フェッチ中で summary がまだ前日のままのタイミングを排除する保険。
  // (current の中身が現在表示中の日付と一致しなければ何もしない)
  if (current.target_date !== dateParam.value) return;
  if (!isStale(current)) return;
  // user-initiated refresh と区別するため、エラーは UI に出さず黙って終わる。
  try {
    await $fetch("/api/summary/refresh", {
      method: "POST",
      headers: summaryFetchHeaders(),
      body: { date: dateParam.value },
    });
    await refreshSummary();
  } catch {
    // 裏で失敗してもユーザー操作を妨げない
  }
}

// =============================================================================
// Lifecycle
// =============================================================================
// 日付遷移時の再フェッチは useAsyncData の watch オプションが担う。
// stale チェックは「日付ごとに 1 回だけ」走らせる。summary 自体を watch すると
// backgroundRefreshIfStale() → refreshSummary() → summary 更新 → watcher 再発火
// のループになり、refresh しても依然 stale なまま (例: sync 完了が遅延、
// last_synced_at がまだ書き込まれていない) のときに POST /api/summary/refresh を
// 連打してしまう。それを避けるため、フェッチが落ち着いた (loading=false) タイミ
// ングで dateParam 単位の再入ガードを通して 1 回だけ発火させる。
// SSR で /api/summary/refresh を叩かないよう onMounted 内で watch を貼る。
onMounted(() => {
  const checkedDates = new Set<string>();
  watch(
    [loading, dateParam],
    ([isLoading, date]) => {
      if (isLoading) return;
      if (checkedDates.has(date)) return;
      const current = summary.value;
      // 日付遷移直後で summary がまだ前日のままのタイミングでは発火しない。
      // 新しい日付の取得完了で loading が false に戻ったタイミングに再評価される。
      if (!current || current.target_date !== date) return;
      checkedDates.add(date);
      void backgroundRefreshIfStale();
    },
    { immediate: true },
  );
});
</script>

<template>
  <DailySummaryView
    :summary="summary"
    :loading="loading"
    :error-message="errorMessage"
    :date-param="dateParam"
    base-path="/daily"
  >
    <template #topbar-action>
      <button
        type="button"
        class="daily-refresh-btn"
        :disabled="refreshing || loading"
        @click="manualRefresh"
      >
        <span
          class="material-symbols-outlined daily-refresh-btn__icon"
          :class="{ 'daily-refresh-btn__icon--spin': refreshing }"
          aria-hidden="true"
        >
          refresh
        </span>
        <span v-if="refreshing">更新中…</span>
        <span v-else>更新</span>
      </button>
      <NuxtLink to="/settings" class="daily-settings-btn" aria-label="設定">
        <span
          class="material-symbols-outlined daily-settings-btn__icon"
          aria-hidden="true"
        >
          settings
        </span>
      </NuxtLink>
    </template>
  </DailySummaryView>
</template>

<style lang="scss" scoped>
// 「更新」ボタンは認証ページ固有のため、コンポーネントではなくここで持つ。
// DailySummaryView と色トーンを揃えるためのトークンを最小限で再宣言する。
$color-text: #1a1814;
$color-accent: #f6dc7a;
$color-accent-hover: #ecce5c;

.daily-refresh-btn {
  padding: 0 16px;
  height: 36px;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: $color-text;
  background: $color-accent;
  border: 1px solid rgba(26, 24, 20, 0.08);
  border-radius: 999px;
  transition:
    background 0.15s,
    transform 0.08s;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: $color-accent-hover;
  }

  &:active:not(:disabled) {
    transform: translateY(1px);
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}

.daily-refresh-btn__icon {
  font-size: 18px;
  line-height: 1;

  &--spin {
    animation: daily-refresh-spin 1s linear infinite;
  }
}

@keyframes daily-refresh-spin {
  to {
    transform: rotate(360deg);
  }
}

.daily-settings-btn {
  width: 36px;
  height: 36px;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  text-decoration: none;
  color: $color-text;
  background: #fff;
  border: 1px solid rgba(26, 24, 20, 0.08);
  border-radius: 999px;
  transition:
    background 0.15s,
    transform 0.08s;

  &:hover {
    background: #f2f0ea;
  }

  &:active {
    transform: translateY(1px);
  }
}

.daily-settings-btn__icon {
  font-size: 20px;
  line-height: 1;
}
</style>
