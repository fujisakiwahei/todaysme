<script setup lang="ts">
// =============================================================================
// AppLoadingOverlay
// Issue #153
//
// 画面遷移時 (Nuxt の page:loading hook 発火中) に画面全体を覆う
// 不透明なオーバーレイ + 緑のアニメーションを表示する。
// app.vue から global にマウントされる。
//
// 注1: useLoadingIndicator() の wrapper である page:loading:start /
//   page:loading:end の hook を直接購読する。SSR では発火しないので、
//   onMounted で hook 登録する (server 側で hook を貼っても無害だが、
//   teardown を簡単にするため client 限定にしている)。
// 注2: 画面遷移を伴わない長い処理 (設定画面の初期ロード / ダッシュボード更新等)
//   は useAppLoading() のカウンタを介して同じオーバーレイを表示する。
// =============================================================================
const pageTransitioning = ref(false);
const { isManualLoading } = useAppLoading();
const isLoading = computed(() => pageTransitioning.value || isManualLoading.value);

const nuxtApp = useNuxtApp();
let unsubStart: (() => void) | null = null;
let unsubEnd: (() => void) | null = null;

onMounted(() => {
  unsubStart = nuxtApp.hook("page:loading:start", () => {
    pageTransitioning.value = true;
  });
  unsubEnd = nuxtApp.hook("page:loading:end", () => {
    pageTransitioning.value = false;
  });
});

onBeforeUnmount(() => {
  unsubStart?.();
  unsubEnd?.();
});
</script>

<template>
  <Transition name="app-loading">
    <div v-if="isLoading" class="app-loading-overlay" role="status" aria-live="polite">
      <div class="ball-clip-rotate-multiple" aria-hidden="true">
        <div />
        <div />
      </div>
      <span class="app-loading-overlay__sr">読み込み中…</span>
    </div>
  </Transition>
</template>

<style lang="scss" scoped>
// design-tone の --color-calendar / --color-bg と揃える
$loading-color: #3e7b5a;
$overlay-bg: #fafaf7;

.app-loading-overlay {
  position: fixed;
  z-index: 9999;
  inset: 0;
  display: grid;
  background: $overlay-bg;
  place-items: center;
}

.app-loading-overlay__sr {
  position: absolute;
  margin: -1px;
  padding: 0;
  width: 1px;
  height: 1px;
  overflow: hidden;
  white-space: nowrap;
  border: 0;
  clip: rect(0, 0, 0, 0);
}

.ball-clip-rotate-multiple {
  position: relative;
  width: 0;
  height: 0;

  > div {
    position: absolute;
    top: -20px;
    left: -20px;
    width: 40px;
    height: 40px;
    border: 2px solid $loading-color;
    border-top-color: transparent;
    border-bottom-color: transparent;
    border-radius: 100%;
    animation: app-loading-rotate 1s ease-in-out infinite;
  }

  > div:last-child {
    top: -10px;
    left: -10px;
    width: 20px;
    height: 20px;
    border-color: $loading-color transparent $loading-color transparent;
    animation-duration: 0.5s;
    animation-direction: reverse;
  }
}

@keyframes app-loading-rotate {
  0% {
    transform: rotate(0deg) scale(1);
  }
  50% {
    transform: rotate(180deg) scale(0.6);
  }
  100% {
    transform: rotate(360deg) scale(1);
  }
}

// fade in/out
.app-loading-enter-active,
.app-loading-leave-active {
  transition: opacity 0.15s ease;
}
.app-loading-enter-from,
.app-loading-leave-to {
  opacity: 0;
}

// motion を抑えるユーザー設定では回転を止めて点滅のみにする
@media (prefers-reduced-motion: reduce) {
  .ball-clip-rotate-multiple > div {
    animation: app-loading-pulse 1.2s ease-in-out infinite;
  }
}

@keyframes app-loading-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
</style>
