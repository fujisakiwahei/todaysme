<script setup lang="ts">
import type {
  ConnectionListResponse,
  ConnectionSummary,
  OauthStartResponse,
  ServiceProvider,
} from "~~/shared/schemas";

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

function statusLabel(s: ConnectionSummary): string {
  if (s.status === "connected" && s.has_token) return "接続中";
  if (s.status === "error") return "エラー";
  return "未接続";
}

// /daily/* から require-connections middleware で飛ばされてきたときの案内バナー。
// クエリには未接続のサービス名が CSV で入る (例: "oura,google")。
// 表示時に provider 名を日本語にマッピングする。
const PROVIDER_LABEL_JA: Record<ServiceProvider, string> = {
  oura: "Oura",
  google: "Google Calendar",
  toggl: "Toggl Track",
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
  requireConnectionsMissing.value.map((p) => PROVIDER_LABEL_JA[p]).join(" と "),
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
    <h1>外部サービス連携</h1>

    <p
      v-if="requireConnectionsMissing.length > 0"
      class="settings__message settings__message--warn"
    >
      Today's ME は Oura の起床時刻を基準に 1 日を組み立てるため、Oura と Google
      Calendar の両方を接続しないと利用できません。
      {{ requireConnectionsLabel }} を接続してください。
    </p>

    <p v-if="successMessage" class="settings__message settings__message--ok">
      {{ successMessage }}
    </p>
    <p v-if="errorMessage" class="settings__message settings__message--error">
      {{ errorMessage }}
    </p>

    <section v-if="loading" class="settings__loading">読み込み中...</section>

    <ul v-else class="settings__list">
      <li
        v-for="conn in connections"
        :key="conn.provider"
        class="settings__item"
      >
        <div class="settings__item-head">
          <span class="settings__provider">{{ conn.provider }}</span>
          <span class="settings__status" :data-status="conn.status">{{
            statusLabel(conn)
          }}</span>
        </div>

        <div v-if="conn.provider === 'oura'" class="settings__actions">
          <button
            type="button"
            :disabled="submitting !== null"
            @click="startOAuth('oura')"
          >
            {{ conn.has_token ? "再認可する" : "Oura と接続する" }}
          </button>
          <button
            v-if="conn.has_token"
            type="button"
            :disabled="submitting !== null"
            @click="disconnect('oura')"
          >
            連携解除
          </button>
        </div>

        <div v-else-if="conn.provider === 'google'" class="settings__actions">
          <button
            type="button"
            :disabled="submitting !== null"
            @click="startOAuth('google')"
          >
            {{ conn.has_token ? "再認可する" : "Google Calendar と接続する" }}
          </button>
          <button
            v-if="conn.has_token"
            type="button"
            :disabled="submitting !== null"
            @click="disconnect('google')"
          >
            連携解除
          </button>
        </div>

        <div v-else-if="conn.provider === 'toggl'" class="settings__actions">
          <form class="settings__form" @submit.prevent="saveTogglToken">
            <label>
              Toggl Track API token
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
              :disabled="submitting !== null || !togglToken.trim()"
            >
              {{ conn.has_token ? "更新する" : "保存する" }}
            </button>
          </form>
          <button
            v-if="conn.has_token"
            type="button"
            :disabled="submitting !== null"
            @click="disconnect('toggl')"
          >
            連携解除
          </button>
        </div>
      </li>
    </ul>
  </main>
</template>

<style lang="scss" scoped>
.settings {
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 16px;

  h1 {
    font-size: 1.5rem;
    margin-bottom: 24px;
  }
}

.settings__message {
  padding: 12px 16px;
  border-radius: 6px;
  margin-bottom: 16px;
}

.settings__message--ok {
  background: #e7f6ec;
  color: #1f6b3a;
}

.settings__message--error {
  background: #fdecea;
  color: #8a1b1b;
}

.settings__message--warn {
  background: #fff7e0;
  color: #6a4d00;
  border: 1px solid #f0d27a;
}

.settings__loading {
  color: #666;
}

.settings__list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0;
  list-style: none;
}

.settings__item {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 16px;
}

.settings__item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.settings__provider {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.settings__status {
  font-size: 0.875rem;

  &[data-status="connected"] {
    color: #1f6b3a;
  }

  &[data-status="disconnected"] {
    color: #888;
  }

  &[data-status="error"] {
    color: #8a1b1b;
  }
}

.settings__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: end;

  button {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid #888;
    background: #fff;
    cursor: pointer;

    &:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  }
}

.settings__form {
  display: flex;
  align-items: end;
  gap: 8px;
  flex: 1;
  min-width: 280px;

  label {
    display: flex;
    flex-direction: column;
    flex: 1;
    font-size: 0.875rem;
    gap: 4px;
  }

  input {
    padding: 6px 8px;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-family: inherit;
  }
}
</style>
