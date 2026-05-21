<script setup lang="ts">
const supabase = useSupabaseClient();
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
    const next = encodeURIComponent(resolveRedirect());
    const redirectTo = `${window.location.origin}/auth/callback?next=${next}`;
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
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      await navigateTo(resolveRedirect());
    }
  } finally {
    checkingSession.value = false;
  }
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
        <span class="login__google-mark" aria-hidden="true">
          <svg
            width="20"
            height="20"
            viewBox="0 0 40 40"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <rect
              x="0.5"
              y="0.5"
              width="39"
              height="39"
              rx="19.5"
              fill="white"
            />
            <g clip-path="url(#login-google-clip)">
              <path
                d="M29.6 20.2273C29.6 19.5182 29.5364 18.8364 29.4182 18.1818H20V22.05H25.3818C25.15 23.3 24.4455 24.3591 23.3864 25.0682V27.5773H26.6182C28.5091 25.8364 29.6 23.2727 29.6 20.2273Z"
                fill="#4285F4"
              />
              <path
                d="M20 30C22.7 30 24.9636 29.1045 26.6181 27.5773L23.3863 25.0682C22.4909 25.6682 21.3454 26.0227 20 26.0227C17.3954 26.0227 15.1909 24.2636 14.4045 21.9H11.0636V24.4909C12.7091 27.7591 16.0909 30 20 30Z"
                fill="#34A853"
              />
              <path
                d="M14.4045 21.9C14.2045 21.3 14.0909 20.6591 14.0909 20C14.0909 19.3409 14.2045 18.7 14.4045 18.1V15.5091H11.0636C10.3864 16.8591 10 18.3864 10 20C10 21.6136 10.3864 23.1409 11.0636 24.4909L14.4045 21.9Z"
                fill="#FBBC04"
              />
              <path
                d="M20 13.9773C21.4681 13.9773 22.7863 14.4818 23.8227 15.4727L26.6909 12.6045C24.9591 10.9909 22.6954 10 20 10C16.0909 10 12.7091 12.2409 11.0636 15.5091L14.4045 18.1C15.1909 15.7364 17.3954 13.9773 20 13.9773Z"
                fill="#E94235"
              />
            </g>
            <rect
              x="0.5"
              y="0.5"
              width="39"
              height="39"
              rx="19.5"
              stroke="#747775"
            />
            <defs>
              <clipPath id="login-google-clip">
                <rect
                  width="20"
                  height="20"
                  fill="white"
                  transform="translate(10 10)"
                />
              </clipPath>
            </defs>
          </svg>
        </span>
        <span class="login__google-label">Google でログイン</span>
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

      <p class="login__footer">
        初回の方は
        <NuxtLink to="/signup" class="login__footer-link">
          アカウントを作成
        </NuxtLink>
      </p>
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
$color-sleep: #3b4f86;
$color-sleep-hover: #314171;
$font-mono: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;

.login {
  position: relative;
  padding: 64px 20px 32px;
  width: 100%;
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  overflow-x: hidden;
  overflow-y: auto;
  background: $color-bg;

  &::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image:
      radial-gradient(
        circle at 25% 30%,
        rgba(59, 79, 134, 0.05),
        transparent 45%
      ),
      radial-gradient(
        circle at 75% 70%,
        rgba(194, 104, 58, 0.04),
        transparent 45%
      );
    pointer-events: none;
  }

  @media (max-width: 480px) {
    padding: 56px 16px 24px;
  }
}

.login__back {
  position: absolute;
  z-index: 1;
  top: 20px;
  left: 20px;
  font-size: 12px;
  text-decoration: none;
  color: $color-text-muted;
  transition: color 0.15s;

  &:hover {
    color: $color-text;
  }

  @media (max-width: 480px) {
    top: 16px;
    left: 16px;
  }
}

.login__loading {
  font-size: 14px;
  color: $color-text-muted;
}

.login__card {
  position: relative;
  padding: 36px 28px 32px;
  width: 100%;
  max-width: 380px;
  background: $color-bg;
  border: 1px solid $color-border;
  border-radius: 16px;
  box-shadow: 0 4px 14px rgba(26, 24, 20, 0.07);
  flex-shrink: 0;

  @media (max-width: 480px) {
    padding: 28px 20px 24px;
    border-radius: 14px;
  }
}

.login__brand {
  margin-bottom: 24px;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 10px;
}

.login__brand-mark {
  width: 30px;
  height: 30px;
  display: grid;
  font-family: $font-mono;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #fff;
  background: #111827;
  border-radius: 8px;
  place-items: center;
}

.login__brand-name {
  font-size: 15px;
  font-weight: 600;
  color: $color-text;
}

.login__title {
  margin-bottom: 4px;
  font-size: 21px;
  font-weight: 700;
  letter-spacing: -0.01em;
  text-align: center;
  color: $color-text;
}

.login__sub {
  margin-bottom: 22px;
  font-size: 12.5px;
  text-align: center;
  color: $color-text-muted;
}

.login__error {
  margin-bottom: 14px;
  padding: 9px 12px;
  font-size: 12.5px;
  text-align: center;
  color: $color-error;
  background: $color-error-bg;
  border-radius: 8px;
}

.login__google {
  padding: 0 16px;
  width: 100%;
  height: 46px;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  background: $color-sleep;
  border: 1px solid $color-sleep;
  border-radius: 10px;
  box-shadow:
    0 1px 2px rgba(26, 24, 20, 0.08),
    0 2px 6px rgba(59, 79, 134, 0.18);
  transition:
    background 0.15s,
    border-color 0.15s,
    box-shadow 0.15s,
    transform 0.08s;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: $color-sleep-hover;
    border-color: $color-sleep-hover;
  }

  &:active:not(:disabled) {
    transform: translateY(1px);
  }

  &:disabled {
    box-shadow: none;
    opacity: 0.55;
    cursor: not-allowed;
  }
}

.login__google-mark {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  flex-shrink: 0;

  svg {
    display: block;
  }
}

.login__google-label {
  letter-spacing: 0.01em;
}

.login__divider {
  margin: 18px 0;
  display: flex;
  align-items: center;
  gap: 12px;
  font-family: $font-mono;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: $color-text-muted;

  &::before,
  &::after {
    content: "";
    height: 1px;
    flex: 1;
    background: $color-border;
  }
}

.login__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.login__field {
  display: flex;
  flex-direction: column;
  gap: 6px;

  label {
    font-family: $font-mono;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: $color-text-muted;
  }

  input {
    padding: 0 12px;
    width: 100%;
    height: 40px;
    font-size: 14px;
    color: $color-text;
    background: $color-bg;
    border: 1px solid $color-border;
    border-radius: 8px;
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
    box-sizing: border-box;

    &::placeholder {
      color: $color-text-muted;
      opacity: 0.6;
    }

    &:hover:not(:focus) {
      border-color: darken($color-border, 8%);
    }

    &:focus {
      border-color: transparent;
      outline: 2px solid $color-info;
      outline-offset: -1px;
    }
  }
}

.login__submit {
  margin-top: 6px;
  width: 100%;
  height: 44px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: $color-bg;
  background: $color-text;
  border: none;
  border-radius: 10px;
  box-shadow: 0 1px 2px rgba(26, 24, 20, 0.1);
  transition:
    background 0.15s,
    transform 0.08s,
    box-shadow 0.15s;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: #000;
  }

  &:active:not(:disabled) {
    transform: translateY(1px);
  }

  &:disabled {
    box-shadow: none;
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.login__footer {
  margin-top: 22px;
  font-size: 12px;
  text-align: center;
  color: $color-text-muted;
}

.login__footer-link {
  text-decoration: underline;
  color: $color-info;
  text-underline-offset: 3px;

  &:hover {
    color: darken($color-info, 8%);
  }
}
</style>
