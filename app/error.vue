<script setup lang="ts">
import type { NuxtError } from "#app";

const props = defineProps<{
  error: NuxtError;
}>();

const isNotFound = computed(() => Number(props.error?.statusCode) === 404);

const statusCode = computed(() => {
  const code = Number(props.error?.statusCode);
  return Number.isFinite(code) && code > 0 ? code : 500;
});

const title = computed(() =>
  isNotFound.value ? "ページが見つかりません" : "予期しないエラーが発生しました"
);

const description = computed(() =>
  isNotFound.value
    ? "URL が変更されたか、もう存在しないページの可能性があります。"
    : "時間をおいてから再度お試しください。問題が続く場合は管理者にお問い合わせください。"
);

async function goHome() {
  await clearError({ redirect: "/" });
}

async function goLogin() {
  await clearError({ redirect: "/login" });
}
</script>

<template>
  <main class="error">
    <div class="error__brand">
      <div class="error__brand-mark">TM</div>
      <div class="error__brand-name">Today's ME</div>
    </div>

    <section class="error__hero">
      <p class="error__eyebrow">
        {{ isNotFound ? "404 · Not Found" : `${statusCode} · Error` }}
      </p>
      <h1 class="error__code">
        {{ isNotFound ? "404" : statusCode }}
      </h1>
      <h2 class="error__title">{{ title }}</h2>
      <p class="error__desc">{{ description }}</p>

      <div class="error__actions">
        <button type="button" class="error__primary" @click="goHome">トップへ戻る →</button>
        <button type="button" class="error__secondary" @click="goLogin">ログインへ</button>
      </div>
    </section>

    <p class="error__footer">© 2026 Today's ME</p>
  </main>
</template>

<style lang="scss" scoped>
$color-bg: #fafaf7;
$color-surface: #f2f0ea;
$color-border: #e2dfd6;
$color-text: #1a1814;
$color-text-muted: #6b6960;
$color-text-dim: #9e9c92;
$font-mono: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;

.error {
  position: relative;
  padding: 48px 24px;
  width: 100%;
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  overflow: hidden;
  background: $color-bg;

  &::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image:
      radial-gradient(circle at 20% 25%, rgba(59, 79, 134, 0.06), transparent 50%),
      radial-gradient(circle at 80% 75%, rgba(212, 168, 44, 0.05), transparent 50%);
    pointer-events: none;
  }

  @media (max-width: 480px) {
    padding: 32px 16px;
  }
}

.error__brand {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 10px;
}

.error__brand-mark {
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

.error__brand-name {
  font-size: 15px;
  font-weight: 600;
  color: $color-text;
}

.error__hero {
  position: relative;
  z-index: 1;
  margin: auto 0;
  padding: 40px 0;
  width: 100%;
  max-width: 720px;
  text-align: center;
}

.error__eyebrow {
  margin-bottom: 28px;
  font-family: $font-mono;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: $color-text-muted;

  @media (max-width: 480px) {
    margin-bottom: 20px;
    font-size: 11px;
  }
}

.error__code {
  margin: 0;
  font-family: $font-mono;
  font-size: clamp(140px, 28vw, 280px);
  font-weight: 700;
  line-height: 0.9;
  letter-spacing: -0.05em;
  color: $color-text;
  background: linear-gradient(180deg, $color-text 0%, $color-text 55%, rgba(26, 24, 20, 0.35) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.error__title {
  margin-top: 24px;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: $color-text;

  @media (max-width: 480px) {
    margin-top: 18px;
    font-size: 18px;
  }
}

.error__desc {
  margin-top: 10px;
  font-size: 14px;
  line-height: 1.7;
  color: $color-text-muted;

  @media (max-width: 480px) {
    font-size: 13px;
  }
}

.error__actions {
  margin-top: 36px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 12px;

  @media (max-width: 480px) {
    margin-top: 28px;
    flex-direction: column;
    gap: 10px;
  }
}

.error__primary {
  padding: 0 22px;
  height: 46px;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: $color-bg;
  background: $color-text;
  border: 1px solid $color-text;
  border-radius: 10px;
  box-shadow: 0 1px 2px rgba(26, 24, 20, 0.1);
  transition:
    background 0.15s,
    transform 0.08s,
    box-shadow 0.15s;
  cursor: pointer;

  &:hover {
    background: #000;
  }

  &:active {
    transform: translateY(1px);
  }

  @media (max-width: 480px) {
    width: 100%;
  }
}

.error__secondary {
  padding: 0 22px;
  height: 46px;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: $color-text;
  background: $color-bg;
  border: 1px solid $color-border;
  border-radius: 10px;
  transition:
    background 0.15s,
    border-color 0.15s,
    transform 0.08s;
  cursor: pointer;

  &:hover {
    background: $color-surface;
    border-color: color.adjust($color-border, $lightness: -8%);
  }

  &:active {
    transform: translateY(1px);
  }

  @media (max-width: 480px) {
    width: 100%;
  }
}

.error__footer {
  position: relative;
  z-index: 1;
  margin-top: auto;
  font-family: $font-mono;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: $color-text-dim;
}
</style>
