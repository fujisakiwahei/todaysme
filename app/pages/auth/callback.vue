<script setup lang="ts">
// OAuth / magic link callback。
// PKCE フロー (`?code=...`) では exchangeCodeForSession を呼ぶ必要があり、
// `@nuxtjs/supabase` 側の自動 redirect を `redirect: false` で無効化しているため
// 自前で処理する。
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

onMounted(async () => {
  try {
    const code = route.query.code;
    const oauthError = route.query.error_description ?? route.query.error;
    if (typeof oauthError === "string") {
      errorMessage.value = oauthError;
      return;
    }

    if (typeof code === "string") {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        errorMessage.value = `認可コードの交換に失敗しました: ${error.message}`;
        return;
      }
    } else {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        errorMessage.value = "サインインに失敗しました。再度お試しください。";
        return;
      }
    }

    await navigateTo(resolveNext(), { replace: true });
  } catch (e) {
    errorMessage.value =
      e instanceof Error ? e.message : "サインインに失敗しました";
  }
});
</script>

<template>
  <main class="auth-callback">
    <template v-if="errorMessage">
      <p class="auth-callback__error" role="alert">{{ errorMessage }}</p>
      <NuxtLink to="/login" class="auth-callback__link">
        ログイン画面へ戻る
      </NuxtLink>
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
  color: #b83232;
  background: #f5e1e1;
  border-radius: 8px;
  max-width: 480px;
  text-align: center;
}

.auth-callback__link {
  font-size: 13px;
  color: #2b6cb0;
  text-decoration: underline;
  text-underline-offset: 3px;
}
</style>
