<script setup lang="ts">
import type {
  ConnectionListResponse,
  ConnectionSummary,
  OauthStartResponse,
  ServiceProvider,
} from "~~/shared/schemas";
import ouraIcon from "~/assets/styles/images/oura.webp";
import googleCalendarIcon from "~/assets/styles/images/google-calendar.webp";
import togglIcon from "~/assets/styles/images/toggl-track.webp";

definePageMeta({
  middleware: ["auth"],
});

const supabase = useSupabaseClient();
const route = useRoute();

const connections = ref<ConnectionSummary[]>([]);
const loading = ref(true);
const submitting = ref<ServiceProvider | null>(null);
const togglToken = ref("");
const errorMessage = ref<string | null>(null);
const successMessage = ref<string | null>(null);

async function bearerHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function loadConnections() {
  loading.value = true;
  errorMessage.value = null;
  try {
    const headers = await bearerHeaders();
    const res = await $fetch<ConnectionListResponse>("/api/connections", {
      headers,
    });
    connections.value = res.connections;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to load";
    errorMessage.value = `連携状況の取得に失敗しました: ${msg}`;
  } finally {
    loading.value = false;
  }
}

async function startOAuth(provider: "oura" | "google") {
  submitting.value = provider;
  errorMessage.value = null;
  try {
    const headers = await bearerHeaders();
    const res = await $fetch<OauthStartResponse>(
      `/api/connections/${provider}/start`,
      { headers },
    );
    window.location.href = res.authorize_url;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to start oauth";
    errorMessage.value = `${provider} の認可開始に失敗しました: ${msg}`;
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

type ProviderMeta = {
  variant: "sleep" | "calendar" | "work";
  name: string;
  icon: string;
  description: string;
};

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
};

function statusInfo(s: ConnectionSummary): {
  label: string;
  emoji: string;
  variant: "connected" | "disconnected" | "error";
} {
  if (s.status === "connected" && s.has_token) {
    return { label: "接続中", emoji: "✅", variant: "connected" };
  }
  if (s.status === "error") {
    return { label: "エラー", emoji: "⚠️", variant: "error" };
  }
  return { label: "未接続", emoji: "⚪", variant: "disconnected" };
}

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

      <p v-if="successMessage" class="settings__message settings__message--ok">
        {{ successMessage }}
      </p>
      <p v-if="errorMessage" class="settings__message settings__message--error">
        {{ errorMessage }}
      </p>

      <section class="settings__section">
        <h2 class="settings__section-title">連携サービス</h2>

        <p v-if="loading" class="settings__loading">読み込み中...</p>

        <ul v-else class="conn-list">
          <li
            v-for="conn in connections"
            :key="conn.provider"
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

            <div v-else-if="conn.provider === 'google'" class="conn__actions">
              <button
                type="button"
                class="btn btn--primary"
                :disabled="submitting !== null"
                @click="startOAuth('google')"
              >
                {{
                  conn.has_token ? "再認可する" : "Google Calendar と接続する"
                }}
              </button>
              <button
                v-if="conn.has_token"
                type="button"
                class="btn btn--ghost"
                :disabled="submitting !== null"
                @click="disconnect('google')"
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
          </li>
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
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px 6px 10px;
  font-size: 13px;
  font-weight: 500;
  color: $color-text-muted;
  background: #fff;
  border: 1px solid $color-border;
  border-radius: 999px;
  box-shadow: 0 1px 2px rgba(26, 24, 20, 0.04);
  text-decoration: none;
  transition:
    color 0.15s,
    background 0.15s;

  &:hover {
    color: $color-text;
    background: $color-surface;
  }
}

.settings__back-arrow {
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

.settings__loading {
  padding: 32px;
  text-align: center;
  color: $color-text-muted;
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
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  list-style: none;
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
      grid-column: 1 / -1;
      justify-self: start;
    }
  }
}

.conn__icon {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  border: 1px solid $color-border-2;
  background: #fff;

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
}

.conn__desc {
  margin-top: 2px;
  font-size: 12px;
  color: $color-text-muted;
}

.conn__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
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
  display: flex;
  flex: 1 1 280px;
  align-items: end;
  gap: 8px;
  min-width: 0;
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
      outline: none;
      border-color: $color-accent-hover;
      box-shadow: 0 0 0 3px rgba(246, 220, 122, 0.3);
    }
  }
}

.conn__field-label {
  font-size: 12px;
  font-weight: 500;
  color: $color-text-muted;
}

// -----------------------------------------------------------
// Buttons
// -----------------------------------------------------------
.btn {
  padding: 0 16px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  border-radius: 999px;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s,
    transform 0.08s;

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
</style>
