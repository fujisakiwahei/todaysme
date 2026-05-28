<script setup lang="ts">
// OAuth / magic link callback。
// `@nuxtjs/supabase` v2 は `@supabase/ssr` の createBrowserClient を使うため、
// クライアント初期化時に `detectSessionInUrl` が `?code=...` を自動で交換し、
// PKCE 検証子クッキーを消費する。自前で exchangeCodeForSession を呼ぶと検証子が
// 既に消えていて必ず失敗するため、ここでは SIGNED_IN イベント (or getSession) を
// 待ってセッション確立後に遷移する。Issue #200。
definePageMeta({ layout: false });

const supabase = useSupabaseClient();
const route = useRoute();
const errorMessage = ref<string | null>(null);

function resolveNext(): string {
  const raw = route.query.next;
  if (typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }
  return "/daily/today";
}

function waitForSignIn(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) {
        subscription.unsubscribe();
        clearTimeout(timer);
        resolve(true);
      }
    });
    const timer = setTimeout(() => {
      subscription.unsubscribe();
      resolve(false);
    }, timeoutMs);
  });
}

onMounted(async () => {
  try {
    const oauthError = route.query.error_description ?? route.query.error;
    if (typeof oauthError === "string") {
      errorMessage.value = oauthError;
      return;
    }

    const { data: existing } = await supabase.auth.getSession();
    if (existing.session) {
      await navigateTo(resolveNext(), { replace: true });
      return;
    }

    const code = route.query.code;
    if (typeof code === "string") {
      const signedIn = await waitForSignIn(5000);
      if (signedIn) {
        await navigateTo(resolveNext(), { replace: true });
        return;
      }
    }

    errorMessage.value = "サインインに失敗しました。再度お試しください。";
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : "サインインに失敗しました";
  }
});
</script>

<template>
  <main class="auth-callback">
    <template v-if="errorMessage">
      <p class="auth-callback__error" role="alert">{{ errorMessage }}</p>
      <NuxtLink to="/login" class="auth-callback__link"> ログイン画面へ戻る </NuxtLink>
    </template>
    <p v-else class="auth-callback__loading">サインインを完了しています...</p>
  </main>
</template>

<style lang="scss" scoped>
.auth-callback {
  padding: 64px 20px;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 16px;
  font-size: 14px;
  color: #1a1814;
  background: #fafaf7;
}

.auth-callback__loading {
  color: #6b6960;
}

.auth-callback__error {
  padding: 12px 16px;
  max-width: 480px;
  text-align: center;
  color: #b83232;
  background: #f5e1e1;
  border-radius: 8px;
}

.auth-callback__link {
  font-size: 13px;
  text-decoration: underline;
  color: #2b6cb0;
  text-underline-offset: 3px;
}
</style>
