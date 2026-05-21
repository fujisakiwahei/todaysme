<script setup lang="ts">
const supabase = useSupabase();
const route = useRoute();

const email = ref("");
const password = ref("");
const submitting = ref(false);
const checkingSession = ref(true);
const errorMessage = ref<string | null>(null);

function resolveRedirect(): string {
  const raw = route.query.redirect;
  if (typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }
  return "/daily/today";
}

async function loginWithGoogle() {
  errorMessage.value = null;
  submitting.value = true;
  try {
    const redirectTo = `${window.location.origin}${resolveRedirect()}`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) throw error;
  } catch (e) {
    const msg =
      e instanceof Error ? e.message : "Google ログインに失敗しました";
    errorMessage.value = msg;
    submitting.value = false;
  }
}

async function loginWithEmail() {
  if (!email.value.trim() || !password.value) return;
  errorMessage.value = null;
  submitting.value = true;
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: email.value.trim(),
      password: password.value,
    });
    if (error) throw error;
    await navigateTo(resolveRedirect());
  } catch (e) {
    const msg =
      e instanceof Error ? e.message : "メールアドレスログインに失敗しました";
    errorMessage.value = msg;
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    await navigateTo(resolveRedirect());
    return;
  }
  checkingSession.value = false;
});
</script>

<template>
  <main class="login">
    <a class="login__back" href="/">← トップへ</a>

    <div v-if="checkingSession" class="login__loading">読み込み中...</div>

    <div v-else class="login__card">
      <div class="login__brand">
        <div class="login__brand-mark">TM</div>
        <div class="login__brand-name">Today's ME</div>
      </div>

      <h1 class="login__title">ログイン</h1>
      <p class="login__sub">きょうの自分を、1 つの時間軸で。</p>

      <p v-if="errorMessage" class="login__error" role="alert">
        {{ errorMessage }}
      </p>

      <button
        type="button"
        class="login__google"
        :disabled="submitting"
        @click="loginWithGoogle"
      >
        Google でログイン
      </button>

      <div class="login__divider">または</div>

      <form class="login__form" @submit.prevent="loginWithEmail">
        <div class="login__field">
          <label for="login-email">メールアドレス</label>
          <input
            id="login-email"
            v-model="email"
            type="email"
            autocomplete="email"
            placeholder="dev@example.com"
            required
          />
        </div>

        <div class="login__field">
          <label for="login-password">パスワード</label>
          <input
            id="login-password"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="••••••••"
            required
          />
        </div>

        <button
          type="submit"
          class="login__submit"
          :disabled="submitting || !email.trim() || !password"
        >
          ログイン →
        </button>
      </form>
    </div>
  </main>
</template>

<style lang="scss" scoped>
$color-bg: #fafaf7;
$color-surface: #f2f0ea;
$color-border: #e2dfd6;
$color-text: #1a1814;
$color-text-muted: #6b6960;
$color-error: #b83232;
$color-error-bg: #f5e1e1;
$color-info: #2b6cb0;
$font-mono: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;

.login {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 40px 24px;
  background: $color-bg;
  position: relative;

  &::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image:
      radial-gradient(
        circle at 25% 30%,
        rgba(59, 79, 134, 0.04),
        transparent 45%
      ),
      radial-gradient(
        circle at 75% 70%,
        rgba(194, 104, 58, 0.04),
        transparent 45%
      );
    pointer-events: none;
  }
}

.login__back {
  position: absolute;
  top: 24px;
  left: 24px;
  font-size: 12px;
  color: $color-text-muted;
  text-decoration: none;
}

.login__loading {
  color: $color-text-muted;
  font-size: 14px;
}

.login__card {
  position: relative;
  width: 420px;
  max-width: 100%;
  padding: 40px 32px;
  background: $color-bg;
  border: 1px solid $color-border;
  border-radius: 16px;
  box-shadow: 0 4px 14px rgba(26, 24, 20, 0.07);
}

.login__brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 28px;
}

.login__brand-mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: #111827;
  color: #fff;
  font-weight: 700;
  font-size: 13px;
  font-family: $font-mono;
}

.login__brand-name {
  font-size: 16px;
  font-weight: 600;
  color: $color-text;
}

.login__title {
  margin-bottom: 4px;
  font-size: 22px;
  font-weight: 700;
  text-align: center;
  letter-spacing: -0.01em;
  color: $color-text;
}

.login__sub {
  margin-bottom: 24px;
  font-size: 13px;
  text-align: center;
  color: $color-text-muted;
}

.login__error {
  margin-bottom: 16px;
  padding: 10px 12px;
  background: $color-error-bg;
  color: $color-error;
  border-radius: 6px;
  font-size: 13px;
  text-align: center;
}

.login__google {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  height: 48px;
  background: $color-bg;
  border: 1px solid $color-border;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  color: $color-text;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: $color-surface;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.login__divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 0;
  font-size: 11px;
  font-family: $font-mono;
  letter-spacing: 0.04em;
  color: $color-text-muted;

  &::before,
  &::after {
    content: "";
    flex: 1;
    height: 1px;
    background: $color-border;
  }
}

.login__form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.login__field {
  display: flex;
  flex-direction: column;
  gap: 6px;

  label {
    font-size: 12px;
    font-weight: 500;
    font-family: $font-mono;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: $color-text-muted;
  }

  input {
    width: 100%;
    height: 44px;
    padding: 0 14px;
    background: $color-bg;
    border: 1px solid $color-border;
    border-radius: 8px;
    font-size: 14px;
    color: $color-text;

    &:focus {
      outline: 2px solid $color-info;
      outline-offset: -1px;
      border-color: transparent;
    }
  }
}

.login__submit {
  width: 100%;
  height: 48px;
  margin-top: 4px;
  background: $color-text;
  color: $color-bg;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: #000;
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}
</style>
