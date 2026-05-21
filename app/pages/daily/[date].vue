<script setup lang="ts">
// =============================================================================
// /daily/[date]
// SPEC §4 / §5 / §9.3 / §10 / Issue #35
//
//   - GET /api/summary?date=YYYY-MM-DD で対象日の Today's ME と Wake-based
//     Timeline 用データを取得して表示する。
//   - 当日かつ sync_status の last_synced_at が 30 分以上古ければ、表示直後に
//     裏で POST /api/summary/refresh を呼ぶ (SPEC §10.2)。
//   - 手動「更新」ボタンで同じ refresh を呼び、終了後に再フェッチする。
//   - 過去日も手動更新は許容する (SPEC §10.2 / §10.3)。
//   - 描画は DailySummaryView コンポーネントに委譲する (Issue #31)。
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

const supabase = useSupabaseClient();

async function bearerHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const summary = ref<SummaryResponse | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const errorMessage = ref<string | null>(null);

// 連続して日付ナビを叩いたときに、古いリクエストのレスポンスで新しい
// 日付の表示を上書きしないよう、各フェッチに連番を振って「自分が最新
// でなければ summary / errorMessage / loading を書かない」で守る。
let activeRequestId = 0;

// /api/summary の取得本体。エラーハンドリング (errorMessage / loading) は呼び出し側に任せ、
// バックグラウンド再フェッチが UI のエラーバナーを書き換えないよう分離している。
// reqId が activeRequestId と一致しなければ stale なレスポンスとして破棄する。
async function fetchSummaryCore(reqId: number) {
  const headers = await bearerHeaders();
  const res = await $fetch<SummaryResponse>("/api/summary", {
    query: { date: dateParam.value },
    headers,
  });
  if (reqId !== activeRequestId) return;
  summary.value = res;
}

async function fetchSummary() {
  const reqId = ++activeRequestId;
  loading.value = true;
  errorMessage.value = null;
  try {
    await fetchSummaryCore(reqId);
  } catch (e) {
    if (reqId !== activeRequestId) return;
    const msg = e instanceof Error ? e.message : "failed to load summary";
    errorMessage.value = `サマリー取得に失敗しました: ${msg}`;
  } finally {
    if (reqId === activeRequestId) {
      loading.value = false;
    }
  }
}

async function manualRefresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  errorMessage.value = null;
  try {
    const headers = await bearerHeaders();
    await $fetch("/api/summary/refresh", {
      method: "POST",
      headers,
      body: { date: dateParam.value },
    });
    await fetchSummary();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to refresh";
    errorMessage.value = `更新に失敗しました: ${msg}`;
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
  if (!summary.value) return;
  if (!isStale(summary.value)) return;
  // user-initiated refresh と区別するため、エラーは UI に出さず黙って終わる。
  // 再フェッチも errorMessage を書き換えない fetchSummaryCore を使う。
  const reqId = ++activeRequestId;
  try {
    const headers = await bearerHeaders();
    await $fetch("/api/summary/refresh", {
      method: "POST",
      headers,
      body: { date: dateParam.value },
    });
    if (reqId !== activeRequestId) return;
    await fetchSummaryCore(reqId);
  } catch {
    // 裏で失敗してもユーザー操作を妨げない
  }
}

// =============================================================================
// Lifecycle
// =============================================================================
// 初回フェッチは onMounted (client) で行う。useSupabaseClient はクライアントで
// セッションを Cookie から復元するが、$fetch の Authorization ヘッダを安全に
// 載せるためにマウント後に session token を取得してから呼ぶ。
// 日付遷移後の再フェッチは watcher で拾う (immediate: false)。
watch(dateParam, async () => {
  summary.value = null;
  await fetchSummary();
  void backgroundRefreshIfStale();
});

onMounted(async () => {
  await fetchSummary();
  void backgroundRefreshIfStale();
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
</style>
