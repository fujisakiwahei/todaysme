<script setup lang="ts">
import type {
  ConnectionListResponse,
  ConnectionSummary,
  GoogleAccount,
  GoogleAccountsResponse,
  GoogleCalendarItem,
  GoogleCalendarsResponse,
  GoogleExcludedCalendarsUpdateResponse,
  OauthStartResponse,
  ServiceProvider,
} from "~~/shared/schemas";
import ouraIcon from "~/assets/styles/images/oura.webp";
import googleCalendarIcon from "~/assets/styles/images/google-calendar.webp";
import togglIcon from "~/assets/styles/images/toggl-track.webp";
import todoistIcon from "~/assets/styles/images/todoist.svg";

definePageMeta({
  middleware: ["auth"],
});

const supabase = useSupabaseClient();
const route = useRoute();
const { begin: beginAppLoading, end: endAppLoading } = useAppLoading();

const connections = ref<ConnectionSummary[]>([]);
const loading = ref(true);
const submitting = ref<ServiceProvider | null>(null);
const togglToken = ref("");
const todoistToken = ref("");
const errorMessage = ref<string | null>(null);
const successMessage = ref<string | null>(null);

// -- Issue #131 Phase 3+: 複数 Google アカウント連携 -------------------------
// /api/connections/google/accounts は接続行を 0..N 件返す。
// Oura / Toggl は引き続き /api/connections の単一行で扱う。
const googleAccounts = ref<GoogleAccount[]>([]);
const googleAccountsLoading = ref(false);
// 操作中の Google アカウント (connection_id) を追跡する。
// /api/connections の submitting (provider 単位) と独立。
const googleSubmittingId = ref<string | null>(null);

// -- Google カレンダー除外設定 (Issue #108 / Issue #131 Phase 5) --------------
// 接続単位で「カレンダー一覧 + 除外設定」を持つ。Map のキーは
// connection_id。各値は { calendars, excludedDraft, loaded, loading,
// saving, error } を持つ。Vue 3 で `ref<Map>` を reactive に扱うため、
// 代入時には新しい Map をセットして参照を差し替える。
interface CalendarPaneState {
  calendars: GoogleCalendarItem[];
  excludedDraft: Set<string>;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
}
const calendarPanes = ref<Map<string, CalendarPaneState>>(new Map());

function emptyPane(): CalendarPaneState {
  return {
    calendars: [],
    excludedDraft: new Set<string>(),
    loaded: false,
    loading: false,
    saving: false,
    error: null,
  };
}

function setPane(connectionId: string, next: CalendarPaneState) {
  const map = new Map(calendarPanes.value);
  map.set(connectionId, next);
  calendarPanes.value = map;
}

function getPane(connectionId: string): CalendarPaneState {
  return calendarPanes.value.get(connectionId) ?? emptyPane();
}

// 接続単位の dirty 判定 (= 保存ボタンを enable するか)。
function paneDirty(connectionId: string): boolean {
  const pane = calendarPanes.value.get(connectionId);
  if (!pane) return false;
  const initial = new Set(pane.calendars.filter((c) => c.excluded).map((c) => c.id));
  if (initial.size !== pane.excludedDraft.size) return true;
  for (const id of pane.excludedDraft) {
    if (!initial.has(id)) return true;
  }
  return false;
}

async function bearerHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function loadConnections() {
  loading.value = true;
  googleAccountsLoading.value = true;
  errorMessage.value = null;
  // Issue #153 follow-up: 設定画面の初期ロード / 再ロード中は全画面オーバーレイを
  // 出して、画面遷移時と同じアニメーションに統一する。
  beginAppLoading();
  try {
    const headers = await bearerHeaders();
    const [conn, accounts] = await Promise.all([
      $fetch<ConnectionListResponse>("/api/connections", { headers }),
      // Issue #131 Phase 3: Google は accounts エンドポイントで N 件を取得。
      $fetch<GoogleAccountsResponse>("/api/connections/google/accounts", {
        headers,
      }),
    ]);
    connections.value = conn.connections;
    googleAccounts.value = accounts.accounts;

    // Issue #131 Phase 5: 接続済み Google アカウントごとに、カレンダー一覧 +
    // 除外設定をパラレルにロードする。再認可待ち / 切断済みアカウントは
    // (calendars.get.ts が 409 を返すので) ロードしない。
    const usable = accounts.accounts.filter((a) => a.has_token && a.status === "connected");
    const usableIds = new Set(usable.map((a) => a.connection_id));
    // 既に消えたアカウントの pane は破棄する。
    const nextPanes = new Map<string, CalendarPaneState>();
    for (const [id, pane] of calendarPanes.value) {
      if (usableIds.has(id)) nextPanes.set(id, pane);
    }
    calendarPanes.value = nextPanes;

    await Promise.all(usable.map((a) => loadGoogleCalendars(a.connection_id)));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to load";
    errorMessage.value = `連携状況の取得に失敗しました: ${msg}`;
  } finally {
    loading.value = false;
    googleAccountsLoading.value = false;
    endAppLoading();
  }
}

async function loadGoogleCalendars(connectionId: string) {
  const base = getPane(connectionId);
  setPane(connectionId, { ...base, loading: true, error: null });
  try {
    const headers = await bearerHeaders();
    const res = await $fetch<GoogleCalendarsResponse>("/api/connections/google/calendars", {
      headers,
      query: { connection_id: connectionId },
    });
    setPane(connectionId, {
      ...getPane(connectionId),
      calendars: res.calendars,
      excludedDraft: new Set(res.calendars.filter((c) => c.excluded).map((c) => c.id)),
      loaded: true,
      loading: false,
      error: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to load calendars";
    setPane(connectionId, {
      ...getPane(connectionId),
      loading: false,
      error: `カレンダー一覧の取得に失敗しました: ${msg}`,
    });
  }
}

function toggleExcluded(connectionId: string, calendarId: string) {
  const pane = getPane(connectionId);
  const next = new Set(pane.excludedDraft);
  if (next.has(calendarId)) {
    next.delete(calendarId);
  } else {
    next.add(calendarId);
  }
  setPane(connectionId, { ...pane, excludedDraft: next });
}

async function saveExcludedCalendars(connectionId: string) {
  const pane = getPane(connectionId);
  setPane(connectionId, { ...pane, saving: true, error: null });
  successMessage.value = null;
  try {
    const headers = await bearerHeaders();
    const res = await $fetch<GoogleExcludedCalendarsUpdateResponse>(
      "/api/connections/google/excluded-calendars",
      {
        method: "PUT",
        headers,
        body: {
          connection_id: connectionId,
          excluded_calendar_ids: Array.from(pane.excludedDraft),
        },
      }
    );
    // サーバが正規化した結果で UI も更新する。
    const newSet = new Set(res.excluded_calendar_ids);
    setPane(connectionId, {
      ...getPane(connectionId),
      calendars: pane.calendars.map((c) => ({
        ...c,
        excluded: newSet.has(c.id),
      })),
      excludedDraft: newSet,
      saving: false,
    });
    successMessage.value = "除外カレンダーの設定を保存しました。";
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to save";
    setPane(connectionId, {
      ...getPane(connectionId),
      saving: false,
      error: `除外設定の保存に失敗しました: ${msg}`,
    });
  }
}

async function startOAuth(provider: "oura" | "google") {
  submitting.value = provider;
  errorMessage.value = null;
  try {
    const headers = await bearerHeaders();
    const res = await $fetch<OauthStartResponse>(`/api/connections/${provider}/start`, { headers });
    window.location.href = res.authorize_url;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to start oauth";
    errorMessage.value = `${provider} の認可開始に失敗しました: ${msg}`;
    submitting.value = null;
  }
}

// Issue #131 Phase 3: 「別のアカウントを追加」用に intent=add を付けて
// /start を叩く。サーバ側は `prompt=consent select_account` を付けて
// Google のアカウントピッカーを必ず出す。
async function startGoogleAddAccount() {
  submitting.value = "google";
  errorMessage.value = null;
  try {
    const headers = await bearerHeaders();
    const res = await $fetch<OauthStartResponse>("/api/connections/google/start?intent=add", {
      headers,
    });
    window.location.href = res.authorize_url;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to start oauth";
    errorMessage.value = `Google アカウント追加の開始に失敗しました: ${msg}`;
    submitting.value = null;
  }
}

async function saveTogglToken() {
  if (!togglToken.value.trim()) return;
  submitting.value = "toggl";
  errorMessage.value = null;
  successMessage.value = null;
  try {
    const headers = await bearerHeaders();
    await $fetch("/api/connections/toggl", {
      method: "POST",
      headers,
      body: { api_token: togglToken.value.trim() },
    });
    togglToken.value = "";
    successMessage.value = "Toggl の API token を保存しました。";
    await loadConnections();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to save token";
    errorMessage.value = `Toggl token の保存に失敗しました: ${msg}`;
  } finally {
    submitting.value = null;
  }
}

// Issue #206: Todoist も Toggl と同じ API token 方式で接続する。
async function saveTodoistToken() {
  if (!todoistToken.value.trim()) return;
  submitting.value = "todoist";
  errorMessage.value = null;
  successMessage.value = null;
  try {
    const headers = await bearerHeaders();
    await $fetch("/api/connections/todoist", {
      method: "POST",
      headers,
      body: { api_token: todoistToken.value.trim() },
    });
    todoistToken.value = "";
    successMessage.value = "Todoist の API token を保存しました。";
    await loadConnections();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to save token";
    errorMessage.value = `Todoist token の保存に失敗しました: ${msg}`;
  } finally {
    submitting.value = null;
  }
}

async function disconnect(provider: ServiceProvider) {
  if (!confirm(`${provider} の連携を解除しますか？`)) return;
  submitting.value = provider;
  errorMessage.value = null;
  successMessage.value = null;
  try {
    const headers = await bearerHeaders();
    await $fetch(`/api/connections/${provider}`, {
      method: "DELETE",
      headers,
    });
    successMessage.value = `${provider} の連携を解除しました。`;
    await loadConnections();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to disconnect";
    errorMessage.value = `${provider} の連携解除に失敗しました: ${msg}`;
  } finally {
    submitting.value = null;
  }
}

// Issue #131 Phase 6: 接続 id 単位の切断。account を指定して呼ぶ。
// API のシェイプは `DELETE /api/connections/google/[connectionId]` (Phase 6 で
// 追加)。同一 user × 同一 provider × 同一 sub の行を対象に soft disconnect する。
async function disconnectGoogleAccount(account: GoogleAccount) {
  const label = account.account_email ?? account.provider_user_id ?? "Google";
  if (!confirm(`Google アカウント (${label}) の連携を解除しますか？`)) return;
  googleSubmittingId.value = account.connection_id;
  errorMessage.value = null;
  successMessage.value = null;
  try {
    const headers = await bearerHeaders();
    await $fetch(`/api/connections/google/${account.connection_id}`, {
      method: "DELETE",
      headers,
    });
    successMessage.value = `Google アカウント (${label}) の連携を解除しました。`;
    await loadConnections();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to disconnect";
    errorMessage.value = `Google アカウントの連携解除に失敗しました: ${msg}`;
  } finally {
    googleSubmittingId.value = null;
  }
}

// Issue #139: 接続行ごと物理削除する。soft disconnect (連携解除) と違い、
// アカウントの行と過去 events を Today's ME から完全に取り除く。
// disconnected 状態でのみ UI から呼ばれる前提だが、API 側でも status を
// 制約していないため、誤って connected 中に呼ばれても削除される。
// 取り返しがつかない操作なので confirm で警告する。
async function deleteGoogleAccount(account: GoogleAccount) {
  const label = account.account_email ?? account.provider_user_id ?? "Google";
  if (
    !confirm(
      `Google アカウント (${label}) を Today's ME から削除しますか？\n` +
        `過去に取得した予定データも含めて完全に削除されます。この操作は取り消せません。`
    )
  )
    return;
  googleSubmittingId.value = account.connection_id;
  errorMessage.value = null;
  successMessage.value = null;
  try {
    const headers = await bearerHeaders();
    await $fetch(`/api/connections/google/${account.connection_id}/account`, {
      method: "DELETE",
      headers,
    });
    successMessage.value = `Google アカウント (${label}) を削除しました。`;
    await loadConnections();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to delete account";
    errorMessage.value = `Google アカウントの削除に失敗しました: ${msg}`;
  } finally {
    googleSubmittingId.value = null;
  }
}

type ProviderMeta = {
  variant: "sleep" | "calendar" | "work" | "task";
  name: string;
  icon: string;
  description: string;
};

// Issue #131 Phase 3: Google は接続行が 0..N 件あるため、
// /api/connections の単一行 (= Oura / Toggl 用) と切り離してループ対象から除外する。
const nonGoogleConnections = computed(() =>
  connections.value.filter((c) => c.provider !== "google")
);
// Google の status バッジ用にサマリ風オブジェクトを返す。表示専用。
// 複数アカウントある場合、いずれかが connected なら "接続中"、全て needs_reauth
// なら "再認可が必要"、全て disconnected なら "未接続"、…で表現する。
const googleAggregateStatus = computed<"connected" | "needs_reauth" | "error" | "disconnected">(
  () => {
    const list = googleAccounts.value;
    if (list.length === 0) return "disconnected";
    if (list.some((a) => a.has_token && a.status === "connected")) return "connected";
    if (list.some((a) => a.status === "needs_reauth")) return "needs_reauth";
    if (list.some((a) => a.status === "error")) return "error";
    return "disconnected";
  }
);

const providerMeta: Record<ServiceProvider, ProviderMeta> = {
  oura: {
    variant: "sleep",
    name: "Oura",
    icon: ouraIcon,
    description: "睡眠データを取得 (Sleep レーン)",
  },
  google: {
    variant: "calendar",
    name: "Google Calendar",
    icon: googleCalendarIcon,
    description: "予定を取得 (Calendar レーン)",
  },
  toggl: {
    variant: "work",
    name: "Toggl Track",
    icon: togglIcon,
    description: "作業ログを取得 (Work レーン)",
  },
  todoist: {
    variant: "task",
    name: "Todoist",
    icon: todoistIcon,
    description: "完了タスクを取得 (日記用 Markdown コピー)",
  },
};

function statusInfo(s: ConnectionSummary): {
  label: string;
  emoji: string;
  variant: "connected" | "disconnected" | "error" | "needs_reauth";
} {
  if (s.status === "connected" && s.has_token) {
    return { label: "接続中", emoji: "✅", variant: "connected" };
  }
  if (s.status === "needs_reauth") {
    // Issue #131 Phase 2: 既存接続だが provider_user_id (sub) を取り直す
    // 必要がある状態。loadConnectionForToken はこの行を未接続扱いするため、
    // 表示上もユーザーに再認可を促すラベルにする。
    return { label: "再認可が必要", emoji: "⚠️", variant: "needs_reauth" };
  }
  if (s.status === "error") {
    return { label: "エラー", emoji: "⚠️", variant: "error" };
  }
  return { label: "未接続", emoji: "⚪", variant: "disconnected" };
}

// /daily/* から require-connections middleware で飛ばされてきたときの案内バナー。
// クエリには未接続のサービス名が CSV で入る (例: "oura,google")。
// 表示時に provider 名を日本語にマッピングする。
const PROVIDER_LABEL_JA: Record<ServiceProvider, string> = {
  oura: "Oura",
  google: "Google Calendar",
  toggl: "Toggl Track",
  todoist: "Todoist",
};
const requireConnectionsMissing = computed<ServiceProvider[]>(() => {
  const raw = route.query.require_connections;
  if (typeof raw !== "string" || raw.length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ServiceProvider => s in PROVIDER_LABEL_JA);
});
const requireConnectionsLabel = computed(() =>
  requireConnectionsMissing.value.map((p) => PROVIDER_LABEL_JA[p]).join(" と ")
);

onMounted(() => {
  // OAuth callback からの戻り値を一度だけ拾って表示する
  const connected = route.query.connected;
  const error = route.query.error;
  if (typeof connected === "string") {
    successMessage.value = `${connected} の連携が完了しました。`;
  }
  if (typeof error === "string") {
    const provider = route.query.provider;
    const prefix = typeof provider === "string" ? `${provider}: ` : "";
    errorMessage.value = `${prefix}${error}`;
  }
  loadConnections();
});
</script>

<template>
  <main class="settings">
    <div class="settings__container">
      <header class="settings__topbar">
        <NuxtLink to="/daily/today" class="settings__back">
          <span class="settings__back-arrow" aria-hidden="true">‹</span>
          ダッシュボードに戻る
        </NuxtLink>
        <div class="settings__title-block">
          <h1 class="settings__title">設定</h1>
          <p class="settings__subtitle">外部サービス連携の管理</p>
        </div>
      </header>

      <p
        v-if="requireConnectionsMissing.length > 0"
        class="settings__message settings__message--warn"
      >
        Today's ME は Oura の起床時刻を基準に 1 日を組み立てるため、Oura と Google Calendar
        の両方を接続しないと利用できません。
        {{ requireConnectionsLabel }} を接続してください。
      </p>

      <p v-if="successMessage" class="settings__message settings__message--ok">
        {{ successMessage }}
      </p>
      <p v-if="errorMessage" class="settings__message settings__message--error">
        {{ errorMessage }}
      </p>

      <section class="settings__section">
        <h2 class="settings__section-title">連携サービス</h2>

        <!-- 読み込み中は AppLoadingOverlay が画面を覆うのでここではプレースホルダ
             を出さない。連携データ取得が終わり次第、下の conn-list が描画される。-->
        <ul v-if="!loading" class="conn-list">
          <template v-for="conn in nonGoogleConnections" :key="conn.provider">
            <li
              class="conn"
              :class="`conn--${providerMeta[conn.provider].variant}`"
              :data-status="statusInfo(conn).variant"
            >
              <div class="conn__head">
                <span class="conn__icon">
                  <img
                    :src="providerMeta[conn.provider].icon"
                    :alt="providerMeta[conn.provider].name"
                  />
                </span>
                <div class="conn__title-block">
                  <div class="conn__name">
                    {{ providerMeta[conn.provider].name }}
                  </div>
                  <div class="conn__desc">
                    {{ providerMeta[conn.provider].description }}
                  </div>
                </div>
                <span class="conn__status">
                  <span aria-hidden="true">{{ statusInfo(conn).emoji }}</span>
                  {{ statusInfo(conn).label }}
                </span>
              </div>

              <div v-if="conn.provider === 'oura'" class="conn__actions">
                <button
                  type="button"
                  class="btn btn--primary"
                  :disabled="submitting !== null"
                  @click="startOAuth('oura')"
                >
                  {{ conn.has_token ? "再認可する" : "Oura と接続する" }}
                </button>
                <button
                  v-if="conn.has_token"
                  type="button"
                  class="btn btn--ghost"
                  :disabled="submitting !== null"
                  @click="disconnect('oura')"
                >
                  連携解除
                </button>
              </div>

              <div v-else-if="conn.provider === 'toggl'" class="conn__actions">
                <form class="conn__form" @submit.prevent="saveTogglToken">
                  <label class="conn__field">
                    <span class="conn__field-label">Toggl Track API token</span>
                    <input
                      v-model="togglToken"
                      type="password"
                      autocomplete="off"
                      spellcheck="false"
                      placeholder="Profile から発行した API token"
                    />
                  </label>
                  <button
                    type="submit"
                    class="btn btn--primary"
                    :disabled="submitting !== null || !togglToken.trim()"
                  >
                    {{ conn.has_token ? "更新する" : "保存する" }}
                  </button>
                </form>
                <button
                  v-if="conn.has_token"
                  type="button"
                  class="btn btn--ghost"
                  :disabled="submitting !== null"
                  @click="disconnect('toggl')"
                >
                  連携解除
                </button>
              </div>

              <!-- Issue #206: Todoist も Toggl と同じ API token 方式。 -->
              <div v-else-if="conn.provider === 'todoist'" class="conn__actions">
                <form class="conn__form" @submit.prevent="saveTodoistToken">
                  <label class="conn__field">
                    <span class="conn__field-label">Todoist API token</span>
                    <input
                      v-model="todoistToken"
                      type="password"
                      autocomplete="off"
                      spellcheck="false"
                      placeholder="設定 → 連携機能 → API トークン から発行"
                    />
                  </label>
                  <button
                    type="submit"
                    class="btn btn--primary"
                    :disabled="submitting !== null || !todoistToken.trim()"
                  >
                    {{ conn.has_token ? "更新する" : "保存する" }}
                  </button>
                </form>
                <button
                  v-if="conn.has_token"
                  type="button"
                  class="btn btn--ghost"
                  :disabled="submitting !== null"
                  @click="disconnect('todoist')"
                >
                  連携解除
                </button>
              </div>
            </li>

            <!-- Issue #131 Phase 3+: Oura カードの直後に Google
                 マルチアカウントブロックを差し込んで「Oura → Google → Toggl」
                 の視覚順を保つ。-->
            <li
              v-if="conn.provider === 'oura'"
              class="conn conn--calendar"
              :data-status="googleAggregateStatus"
            >
              <div class="conn__head">
                <span class="conn__icon">
                  <img :src="providerMeta.google.icon" :alt="providerMeta.google.name" />
                </span>
                <div class="conn__title-block">
                  <div class="conn__name">{{ providerMeta.google.name }}</div>
                  <div class="conn__desc">
                    {{ providerMeta.google.description }}
                  </div>
                </div>
                <span class="conn__status">
                  <span aria-hidden="true">
                    {{
                      googleAggregateStatus === "connected"
                        ? "✅"
                        : googleAggregateStatus === "needs_reauth"
                          ? "⚠️"
                          : googleAggregateStatus === "error"
                            ? "⚠️"
                            : "⚪"
                    }}
                  </span>
                  {{
                    googleAggregateStatus === "connected"
                      ? "接続中"
                      : googleAggregateStatus === "needs_reauth"
                        ? "再認可が必要"
                        : googleAggregateStatus === "error"
                          ? "エラー"
                          : "未接続"
                  }}
                </span>
              </div>

              <p
                v-if="googleAccountsLoading && googleAccounts.length === 0"
                class="conn__exclude-loading"
              >
                Google アカウント情報を読み込み中...
              </p>

              <!-- 接続済みアカウント (0..N 件) -->
              <ul v-if="googleAccounts.length > 0" class="g-accounts">
                <li
                  v-for="acc in googleAccounts"
                  :key="acc.connection_id"
                  class="g-accounts__item"
                  :data-status="acc.status"
                >
                  <div class="g-accounts__head">
                    <span class="g-accounts__email">
                      {{
                        acc.account_email || `Google (...${(acc.provider_user_id ?? "").slice(-4)})`
                      }}
                    </span>
                    <span class="g-accounts__badge" :data-status="acc.status">
                      {{
                        acc.status === "needs_reauth"
                          ? "再認可が必要"
                          : acc.status === "error"
                            ? "エラー"
                            : acc.status === "disconnected"
                              ? "未接続"
                              : "接続中"
                      }}
                    </span>
                  </div>
                  <p v-if="acc.status === 'needs_reauth'" class="conn__reauth-banner" role="alert">
                    Google アカウント連携の仕様変更があり、再認可が必要です。
                  </p>
                  <div class="g-accounts__actions">
                    <button
                      type="button"
                      class="btn btn--primary"
                      :disabled="submitting !== null || googleSubmittingId !== null"
                      @click="startOAuth('google')"
                    >
                      再認可する
                    </button>
                    <!-- Issue #139: 既に未接続の行は「連携解除」が無意味なので、
                         代わりに「アカウント削除」(行ごと物理削除) を出す。
                         needs_reauth / error / connected では従来通り soft の
                         「連携解除」を残す。 -->
                    <button
                      v-if="acc.status === 'disconnected'"
                      type="button"
                      class="btn btn--danger"
                      :disabled="submitting !== null || googleSubmittingId === acc.connection_id"
                      @click="deleteGoogleAccount(acc)"
                    >
                      アカウント削除
                    </button>
                    <button
                      v-else
                      type="button"
                      class="btn btn--ghost"
                      :disabled="submitting !== null || googleSubmittingId === acc.connection_id"
                      @click="disconnectGoogleAccount(acc)"
                    >
                      連携解除
                    </button>
                  </div>

                  <!-- Issue #108 + Issue #131 Phase 5: アカウント単位の
                       「稼働時間集計から除外するカレンダー」設定。connected
                       かつ has_token のアカウントのみで表示する (再認可待ち /
                       エラー時はカレンダー API を叩けないため非表示)。 -->
                  <div v-if="acc.has_token && acc.status === 'connected'" class="conn__exclude">
                    <div class="conn__exclude-head">
                      <span class="conn__exclude-title"> 稼働時間集計から除外するカレンダー </span>
                      <span class="conn__exclude-hint">
                        チェックしたカレンダーのイベントは Timeline
                        には残りますが、稼働時間には数えられず薄く表示されます。
                      </span>
                    </div>

                    <p
                      v-if="getPane(acc.connection_id).error"
                      class="conn__exclude-error"
                      role="alert"
                    >
                      {{ getPane(acc.connection_id).error }}
                    </p>

                    <p
                      v-if="
                        getPane(acc.connection_id).loading && !getPane(acc.connection_id).loaded
                      "
                      class="conn__exclude-loading"
                    >
                      カレンダー一覧を取得中...
                    </p>

                    <ul
                      v-else-if="getPane(acc.connection_id).calendars.length > 0"
                      class="conn__exclude-list"
                    >
                      <li
                        v-for="cal in getPane(acc.connection_id).calendars"
                        :key="cal.id"
                        class="conn__exclude-item"
                      >
                        <label class="conn__exclude-label">
                          <input
                            type="checkbox"
                            :checked="getPane(acc.connection_id).excludedDraft.has(cal.id)"
                            :disabled="getPane(acc.connection_id).saving"
                            @change="toggleExcluded(acc.connection_id, cal.id)"
                          />
                          <span class="conn__exclude-name">
                            {{ cal.name || "（無題のカレンダー）" }}
                          </span>
                          <span v-if="cal.primary" class="conn__exclude-badge"> Primary </span>
                        </label>
                      </li>
                    </ul>
                    <p v-else-if="getPane(acc.connection_id).loaded" class="conn__exclude-loading">
                      カレンダーが見つかりませんでした。
                    </p>

                    <div
                      v-if="getPane(acc.connection_id).calendars.length > 0"
                      class="conn__exclude-foot"
                    >
                      <button
                        type="button"
                        class="btn btn--primary"
                        :disabled="
                          !paneDirty(acc.connection_id) || getPane(acc.connection_id).saving
                        "
                        @click="saveExcludedCalendars(acc.connection_id)"
                      >
                        {{ getPane(acc.connection_id).saving ? "保存中..." : "除外設定を保存" }}
                      </button>
                      <button
                        type="button"
                        class="btn btn--ghost"
                        :disabled="getPane(acc.connection_id).loading"
                        @click="loadGoogleCalendars(acc.connection_id)"
                      >
                        再読み込み
                      </button>
                    </div>
                  </div>
                </li>
              </ul>

              <!-- アカウント追加 / 初回接続ボタン -->
              <div class="conn__actions">
                <button
                  type="button"
                  class="btn btn--primary"
                  :disabled="submitting !== null"
                  @click="
                    googleAccounts.length === 0 ? startOAuth('google') : startGoogleAddAccount()
                  "
                >
                  {{
                    googleAccounts.length === 0
                      ? "Google Calendar と接続する"
                      : "別のアカウントを追加"
                  }}
                </button>
              </div>
            </li>
          </template>
        </ul>
      </section>
    </div>
  </main>
</template>

<style lang="scss" scoped>
// DailySummaryView と色トーンを揃えるためのトークンを最小限で再宣言する。
$color-bg: #fafaf7;
$color-surface: #f2f0ea;
$color-border: #e2dfd6;
$color-border-2: #edebe4;
$color-text: #1a1814;
$color-text-muted: #6b6960;
$color-text-dim: #9aa0a6;
$color-accent: #f6dc7a;
$color-accent-hover: #ecce5c;
$color-sleep: #3b4f86;
$color-sleep-bg: #eaeef6;
$color-calendar: #3e7b5a;
$color-calendar-bg: #e5efe8;
$color-work: #c2683a;
$color-work-bg: #f5e7db;
$color-task: #b23a2c;
$color-task-bg: #f9e5e1;
$color-success: #2f855a;
$color-success-bg: #e6f4ec;
$color-warning: #b7791f;
$color-error: #c53030;
$color-error-bg: #fbe9e9;
$font-mono: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;
$font-en:
  "Geist",
  "Inter",
  system-ui,
  -apple-system,
  sans-serif;

.settings {
  padding: 32px 24px 96px;
  min-height: 100vh;
  min-height: 100dvh;
  font-family: "Geist", "Noto Sans JP", "Hiragino Sans", sans-serif;
  color: $color-text;
  background: $color-bg;

  @media (max-width: 640px) {
    padding: 20px 16px 64px;
  }
}

.settings__container {
  margin: 0 auto;
  max-width: 880px;
}

.settings__topbar {
  margin-bottom: 32px;
}

.settings__back {
  padding: 6px 14px 6px 10px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  color: $color-text-muted;
  background: #fff;
  border: 1px solid $color-border;
  border-radius: 999px;
  box-shadow: 0 1px 2px rgba(26, 24, 20, 0.04);
  transition:
    color 0.15s,
    background 0.15s;

  &:hover {
    color: $color-text;
    background: $color-surface;
  }
}

.settings__back-arrow {
  margin-bottom: 4px;
  font-size: 18px;
  line-height: 0;
}

.settings__title-block {
  margin-top: 20px;
}

.settings__title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;

  @media (max-width: 640px) {
    font-size: 22px;
  }
}

.settings__subtitle {
  margin-top: 4px;
  font-family: $font-mono;
  font-size: 13px;
  color: $color-text-muted;
}

.settings__message {
  margin-bottom: 16px;
  padding: 12px 16px;
  font-size: 13px;
  border-radius: 8px;

  &--ok {
    color: $color-success;
    background: $color-success-bg;
    border: 1px solid $color-success;
  }

  &--error {
    color: $color-error;
    background: $color-error-bg;
    border: 1px solid $color-error;
  }
}

.settings__message--warn {
  color: #6a4d00;
  background: #fff7e0;
  border: 1px solid #f0d27a;
}

.settings__section {
  margin-bottom: 32px;
}

.settings__section-title {
  margin-bottom: 12px;
  font-family: $font-mono;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: $color-text-muted;
}

// -----------------------------------------------------------
// Connection card
// -----------------------------------------------------------
.conn-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.conn {
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: #fff;
  border: 1px solid $color-border;
  border-radius: 16px;
  transition: border-color 0.15s;

  &[data-status="error"] {
    border-color: $color-error;
  }

  &[data-status="needs_reauth"] {
    border-color: $color-warning;
  }

  &[data-status="disconnected"] {
    background: $color-surface;
  }
}

.conn__head {
  display: grid;
  align-items: center;
  gap: 14px;
  grid-template-columns: 44px 1fr auto;

  @media (max-width: 560px) {
    grid-template-columns: 40px 1fr;

    .conn__status {
      justify-self: start;
      grid-column: 1 / -1;
    }
  }
}

.conn__icon {
  width: 44px;
  height: 44px;
  display: grid;
  background: #fff;
  border: 1px solid $color-border-2;
  border-radius: 12px;
  place-items: center;

  .conn--sleep & {
    background: $color-sleep-bg;
    border-color: rgba(59, 79, 134, 0.15);
  }
  .conn--calendar & {
    background: $color-calendar-bg;
    border-color: rgba(62, 123, 90, 0.15);
  }
  .conn--work & {
    background: $color-work-bg;
    border-color: rgba(194, 104, 58, 0.15);
  }
  .conn--task & {
    background: $color-task-bg;
    border-color: rgba(178, 58, 44, 0.15);
  }

  img {
    width: 28px;
    height: 28px;
    object-fit: contain;
  }
}

.conn__title-block {
  min-width: 0;
}

.conn__name {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;

  .conn--sleep & {
    color: $color-sleep;
  }
  .conn--calendar & {
    color: $color-calendar;
  }
  .conn--work & {
    color: $color-work;
  }
  .conn--task & {
    color: $color-task;
  }
}

.conn__desc {
  margin-top: 2px;
  font-size: 12px;
  color: $color-text-muted;
}

.conn__status {
  padding: 6px 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 999px;
  font-variant-numeric: tabular-nums;

  .conn[data-status="connected"] & {
    color: $color-success;
    background: $color-success-bg;
    border: 1px solid rgba(47, 133, 90, 0.25);
  }

  .conn[data-status="disconnected"] & {
    color: $color-text-muted;
    background: #fff;
    border: 1px solid $color-border;
  }

  .conn[data-status="error"] & {
    color: $color-error;
    background: $color-error-bg;
    border: 1px solid rgba(197, 48, 48, 0.25);
  }

  .conn[data-status="needs_reauth"] & {
    color: $color-warning;
    background: #fff7e0;
    border: 1px solid rgba(183, 121, 31, 0.35);
  }
}

// -----------------------------------------------------------
// Google マルチアカウントリスト (Issue #131 Phase 3+)
// -----------------------------------------------------------
.g-accounts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;

  @media (min-width: 561px) {
    margin-left: 58px;
  }
}

.g-accounts__item {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: $color-surface;
  border: 1px solid $color-border-2;
  border-radius: 10px;

  &[data-status="needs_reauth"] {
    background: #fff7e0;
    border-color: $color-warning;
  }

  &[data-status="error"] {
    background: $color-error-bg;
    border-color: $color-error;
  }

  &[data-status="disconnected"] {
    opacity: 0.7;
  }
}

.g-accounts__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.g-accounts__email {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-family: $font-mono;
  font-size: 12px;
  word-break: break-all;
  color: $color-text;
}

.g-accounts__badge {
  padding: 2px 8px;
  flex-shrink: 0;
  font-family: $font-mono;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: $color-text-muted;
  background: #fff;
  border: 1px solid $color-border;
  border-radius: 999px;

  &[data-status="connected"] {
    color: $color-success;
    background: $color-success-bg;
    border-color: rgba(47, 133, 90, 0.25);
  }

  &[data-status="needs_reauth"] {
    color: $color-warning;
    background: #fff7e0;
    border-color: rgba(183, 121, 31, 0.35);
  }

  &[data-status="error"] {
    color: $color-error;
    background: $color-error-bg;
    border-color: rgba(197, 48, 48, 0.25);
  }
}

.g-accounts__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.conn__reauth-banner {
  padding: 8px 12px;
  width: 100%;
  font-size: 12px;
  line-height: 1.5;
  color: #6a4d00;
  background: #fff7e0;
  border: 1px solid #f0d27a;
  border-radius: 8px;
}

.conn__account-email {
  width: 100%;
  font-family: $font-mono;
  font-size: 12px;
  word-break: break-all;
  color: $color-text-muted;
}

.conn__actions {
  padding-left: 58px;
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 8px;

  @media (max-width: 560px) {
    padding-left: 0;
  }
}

.conn__form {
  min-width: 0;
  display: flex;
  flex: 1 1 280px;
  align-items: end;
  gap: 8px;
}

.conn__field {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;

  input {
    padding: 8px 10px;
    height: 36px;
    font-family: inherit;
    font-size: 13px;
    color: $color-text;
    background: #fff;
    border: 1px solid $color-border;
    border-radius: 8px;
    transition: border-color 0.15s;

    &:focus {
      border-color: $color-accent-hover;
      box-shadow: 0 0 0 3px rgba(246, 220, 122, 0.3);
      outline: none;
    }
  }
}

.conn__field-label {
  font-size: 12px;
  font-weight: 500;
  color: $color-text-muted;
}

// -----------------------------------------------------------
// Google カレンダー除外設定 (Issue #108)
// -----------------------------------------------------------
.conn__exclude {
  margin-top: 4px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: $color-surface;
  border: 1px solid $color-border-2;
  border-radius: 12px;

  @media (min-width: 561px) {
    margin-left: 58px;
  }
}

.conn__exclude-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.conn__exclude-title {
  font-size: 13px;
  font-weight: 600;
  color: $color-calendar;
}

.conn__exclude-hint {
  font-size: 12px;
  line-height: 1.5;
  color: $color-text-muted;
}

.conn__exclude-error {
  padding: 8px 12px;
  font-size: 12px;
  color: $color-error;
  background: $color-error-bg;
  border: 1px solid rgba(197, 48, 48, 0.25);
  border-radius: 6px;
}

.conn__exclude-loading {
  padding: 12px;
  font-size: 12px;
  text-align: center;
  color: $color-text-muted;
}

.conn__exclude-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.conn__exclude-item {
  margin: 0;
  padding: 0;
}

.conn__exclude-label {
  padding: 6px 8px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  border-radius: 6px;
  transition: background 0.12s;
  cursor: pointer;

  &:hover {
    background: #fff;
  }

  input[type="checkbox"] {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    accent-color: $color-calendar;
    cursor: pointer;
  }
}

.conn__exclude-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $color-text;
}

.conn__exclude-badge {
  padding: 2px 8px;
  flex-shrink: 0;
  font-family: $font-mono;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: $color-calendar;
  background: $color-calendar-bg;
  border-radius: 999px;
}

.conn__exclude-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

// -----------------------------------------------------------
// Buttons
// -----------------------------------------------------------
.btn {
  padding: 0 16px;
  height: 36px;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 6px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  border-radius: 999px;
  transition:
    background 0.15s,
    border-color 0.15s,
    transform 0.08s;
  cursor: pointer;

  &:active:not(:disabled) {
    transform: translateY(1px);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.btn--primary {
  color: $color-text;
  background: $color-accent;
  border: 1px solid rgba(26, 24, 20, 0.08);

  &:hover:not(:disabled) {
    background: $color-accent-hover;
  }
}

.btn--ghost {
  color: $color-text-muted;
  background: #fff;
  border: 1px solid $color-border;

  &:hover:not(:disabled) {
    color: $color-text;
    background: $color-surface;
  }
}

// Issue #139: アカウント削除など破壊的操作向け。連携解除 (ghost) と並べる
// ケースを想定して、塗りつぶしではなく赤いアウトラインに留める。
.btn--danger {
  color: $color-error;
  background: #fff;
  border: 1px solid $color-error;

  &:hover:not(:disabled) {
    color: #fff;
    background: $color-error;
  }
}
</style>
