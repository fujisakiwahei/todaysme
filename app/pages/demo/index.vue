<script setup lang="ts">
// 公開デモのエントリページ。ログイン不要・外部 API も叩かない。
// 詳細ページ /demo/daily/[date] は別 Issue で実装。
const demoDate = "2026-05-17";
</script>

<template>
  <main class="demo-top">
    <header class="demo-top__nav">
      <NuxtLink to="/" class="demo-top__brand">
        <div class="demo-top__brand-mark">TM</div>
        <span class="demo-top__brand-name">Today's ME</span>
      </NuxtLink>
      <nav class="demo-top__nav-actions">
        <NuxtLink to="/" class="demo-top__nav-link">トップへ戻る</NuxtLink>
        <NuxtLink to="/login" class="demo-top__nav-cta">ログイン</NuxtLink>
      </nav>
    </header>

    <section class="demo-top__hero">
      <p class="demo-top__eyebrow">Public Demo · No Login Required</p>
      <h1 class="demo-top__title">
        Today's ME を、<br />
        <span>サンプルで体験する。</span>
      </h1>
      <p class="demo-top__lede">
        実際の 1 日（<b>{{ demoDate }}</b
        >）の睡眠・予定・作業データを、
        <b>デモ専用テーブル</b>から読んで表示します。<br />
        ログイン不要・外部 API は呼びません。
      </p>
      <div class="demo-top__cta">
        <NuxtLink :to="`/demo/daily/${demoDate}`" class="demo-top__cta-primary">
          {{ demoDate }} のデモを見る →
        </NuxtLink>
        <NuxtLink to="/" class="demo-top__cta-secondary">トップへ戻る</NuxtLink>
      </div>
    </section>

    <section class="demo-top__notes">
      <div class="demo-top__notes-head">
        <span class="demo-top__notes-badge">DEMO</span>
        <h2>このデモについて</h2>
      </div>
      <ul class="demo-top__notes-list">
        <li>
          <b>サンプルデータです。</b
          >表示される数値・予定・作業はすべてサンプル。編集も同期も行われません。
        </li>
        <li>
          <b>外部 API には接続しません。</b>Oura / Google Calendar / Toggl Track
          の本物のデータは取得しません。
        </li>
        <li>
          <b>ナビゲーションは最小構成。</b>デモは
          <code>/demo/daily/{{ demoDate }}</code>
          の 1 ページのみ。更新ボタン等は無効です。
        </li>
        <li>
          自分のデータで使いたい場合は
          <NuxtLink to="/login" class="demo-top__notes-link">ログイン</NuxtLink>
          から（一般公開準備中）。
        </li>
      </ul>
    </section>

    <footer class="demo-top__footer">
      <span>© 2026 Today's ME</span>
      <span>v0.1 · MVP · Asia/Tokyo</span>
    </footer>
  </main>
</template>

<style lang="scss" scoped>
$color-bg: #fafaf7;
$color-surface: #f2f0ea;
$color-surface-2: #ecead3;
$color-border: #e2dfd6;
$color-border-2: #edebe4;
$color-text: #1a1814;
$color-text-muted: #6b6960;
$color-accent: #d4a82c;
$color-accent-hover: #c29823;
$color-demo: #111827;
$font-mono: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;
$font-en:
  "Geist",
  "Inter",
  system-ui,
  -apple-system,
  sans-serif;

.demo-top {
  min-height: 100vh;
  min-height: 100dvh;
  background: $color-bg;
  color: $color-text;
  font-family: "Geist", "Noto Sans JP", "Hiragino Sans", sans-serif;
}

.demo-top__nav {
  display: flex;
  align-items: center;
  padding: 18px 40px;
  border-bottom: 1px solid $color-border;

  @media (max-width: 640px) {
    padding: 14px 20px;
  }
}

.demo-top__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  color: $color-text;
}

.demo-top__brand-mark {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  font-family: $font-en;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  background: $color-demo;
  border-radius: 8px;

  @media (max-width: 640px) {
    width: 24px;
    height: 24px;
    font-size: 11px;
    border-radius: 6px;
  }
}

.demo-top__brand-name {
  font-size: 15px;

  @media (max-width: 640px) {
    font-size: 14px;
  }
}

.demo-top__nav-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.demo-top__nav-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 500;
  color: $color-text-muted;
  border-radius: 999px;
  transition:
    background 0.15s,
    color 0.15s;

  &:hover {
    color: $color-text;
    background: $color-surface;
  }

  @media (max-width: 480px) {
    display: none;
  }
}

.demo-top__nav-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 600;
  color: $color-text;
  background: $color-bg;
  border: 1px solid $color-border;
  border-radius: 999px;
  box-shadow: 0 1px 2px rgba(26, 24, 20, 0.04);
  transition:
    background 0.15s,
    border-color 0.15s;

  &:hover {
    border-color: $color-text;
  }
}

.demo-top__hero {
  max-width: 720px;
  margin: 0 auto;
  padding: 80px 40px 64px;
  text-align: center;

  @media (max-width: 1024px) {
    padding: 56px 32px 48px;
  }

  @media (max-width: 640px) {
    padding: 40px 20px 32px;
  }
}

.demo-top__eyebrow {
  margin-bottom: 16px;
  font-family: $font-mono;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: $color-text-muted;
}

.demo-top__title {
  margin-bottom: 20px;
  font-size: 44px;
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1.15;

  span {
    color: $color-text-muted;
  }

  @media (max-width: 1024px) {
    font-size: 36px;
  }

  @media (max-width: 640px) {
    font-size: 28px;
    margin-bottom: 14px;
  }
}

.demo-top__lede {
  margin: 0 auto 32px;
  max-width: 540px;
  font-size: 16px;
  line-height: 1.7;
  color: $color-text-muted;

  b {
    color: $color-text;
    font-weight: 600;
  }

  @media (max-width: 640px) {
    font-size: 14px;
    margin-bottom: 24px;
  }
}

.demo-top__cta {
  display: flex;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;

  @media (max-width: 480px) {
    flex-direction: column;
    gap: 10px;
  }
}

.demo-top__cta-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 52px;
  padding: 0 28px;
  font-size: 15px;
  font-weight: 600;
  color: $color-text;
  background: $color-accent;
  border: 1px solid rgba(26, 24, 20, 0.08);
  border-radius: 999px;
  box-shadow:
    0 1px 2px rgba(26, 24, 20, 0.08),
    0 2px 6px rgba(26, 24, 20, 0.04);
  transition:
    background 0.15s,
    box-shadow 0.15s,
    transform 0.08s;

  &:hover {
    background: $color-accent-hover;
    box-shadow:
      0 2px 4px rgba(26, 24, 20, 0.12),
      0 4px 12px rgba(26, 24, 20, 0.08);
  }

  &:active {
    transform: translateY(1px);
  }

  @media (max-width: 480px) {
    width: 100%;
  }
}

.demo-top__cta-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 52px;
  padding: 0 28px;
  font-size: 15px;
  font-weight: 600;
  color: $color-text;
  background: $color-bg;
  border: 1px solid $color-border;
  border-radius: 999px;
  box-shadow: 0 1px 2px rgba(26, 24, 20, 0.04);
  transition:
    background 0.15s,
    border-color 0.15s,
    transform 0.08s;

  &:hover {
    border-color: $color-text;
  }

  &:active {
    transform: translateY(1px);
  }

  @media (max-width: 480px) {
    width: 100%;
  }
}

.demo-top__notes {
  max-width: 720px;
  margin: 0 auto;
  padding: 0 40px 80px;

  @media (max-width: 640px) {
    padding: 0 20px 56px;
  }
}

.demo-top__notes-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;

  h2 {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.005em;
  }
}

.demo-top__notes-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  padding: 0 8px;
  font-family: $font-mono;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: #fff;
  background: $color-demo;
  border-radius: 4px;
}

.demo-top__notes-list {
  padding: 20px 24px;
  background: $color-surface;
  border: 1px solid $color-border;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.7;
  color: $color-text-muted;
  list-style: none;

  li {
    position: relative;
    padding-left: 18px;

    &::before {
      content: "·";
      position: absolute;
      left: 4px;
      top: -2px;
      font-size: 18px;
      color: $color-text;
    }

    & + li {
      margin-top: 10px;
    }
  }

  b {
    color: $color-text;
    font-weight: 600;
  }

  code {
    padding: 1px 6px;
    font-family: $font-mono;
    font-size: 12px;
    color: $color-text;
    background: $color-bg;
    border: 1px solid $color-border-2;
    border-radius: 4px;
  }

  @media (max-width: 640px) {
    padding: 16px 18px;
    font-size: 13px;
  }
}

.demo-top__notes-link {
  color: $color-text;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;

  &:hover {
    color: $color-accent-hover;
  }
}

.demo-top__footer {
  display: flex;
  justify-content: space-between;
  padding: 32px 40px 48px;
  font-family: $font-mono;
  font-size: 12px;
  color: $color-text-muted;
  border-top: 1px solid $color-border;

  @media (max-width: 640px) {
    flex-direction: column;
    gap: 6px;
    padding: 24px 20px 32px;
    text-align: center;
    align-items: center;
  }
}
</style>
