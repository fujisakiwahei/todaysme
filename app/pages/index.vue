<script setup lang="ts">
// ログイン済みで `/` に来た場合は LP を見せずに /daily/today へ直行する (Issue #197)。
// SSR 側で user (JWT claims) が確定していれば setup 直下で await navigateTo して 302 を返し、
// クライアント hydration 中に user.value が未確定なケースは watch で拾う
// (/daily/today.vue と同じ流儀)。
const user = useSupabaseUser();

async function redirectToDashboard() {
  await navigateTo("/daily/today", { replace: true });
}

if (user.value?.sub) {
  await redirectToDashboard();
} else if (import.meta.client) {
  const stop = watch(user, async (u) => {
    if (!u?.sub) return;
    stop();
    await redirectToDashboard();
  });
}
</script>

<template>
  <main class="top">
    <header class="top__nav">
      <div class="top__brand">
        <div class="top__brand-mark">TM</div>
        <span class="top__brand-name">Today's ME</span>
      </div>
      <nav class="top__nav-actions">
        <NuxtLink to="/demo" class="top__nav-link">デモを見る</NuxtLink>
        <NuxtLink to="/login" class="top__nav-cta">ログイン</NuxtLink>
      </nav>
    </header>

    <section class="top__hero">
      <div class="top__hero-text">
        <p class="top__eyebrow">Personal Time Dashboard · MVP</p>
        <h1 class="top__title">
          きょうの自分を、<br />
          <span>1 つの時間軸で。</span>
        </h1>
        <p class="top__lede">
          Oura / Google Calendar / Toggl Track を
          <b>起床を 0 時間目とする</b>
          1 つのタイムラインに統合。「今日やること」「今日やったこと」「今日の身体状態」を 1
          画面で把握できます。
        </p>
        <div class="top__cta">
          <NuxtLink to="/demo" class="top__cta-primary">デモを見る</NuxtLink>
          <NuxtLink to="/login" class="top__cta-secondary">ログイン</NuxtLink>
        </div>
      </div>

      <div class="top__concept" aria-hidden="true">
        <div class="top__concept-head">
          <span class="top__concept-title">Wake-based Timeline</span>
          <span class="top__concept-date">2026-05-17</span>
        </div>
        <div class="top__concept-axis">
          <span>0h</span><span>3h</span><span>6h</span><span>9h</span><span>+11.5</span>
        </div>
        <div class="top__concept-lane">
          <span class="top__concept-label top__concept-label--sleep">Sleep</span>
          <div class="top__concept-track">
            <div class="top__concept-bar top__concept-bar--sleep" style="left: 0; width: 2px" />
          </div>
        </div>
        <div class="top__concept-lane">
          <span class="top__concept-label top__concept-label--calendar"> Calendar </span>
          <div class="top__concept-track">
            <div
              class="top__concept-bar top__concept-bar--calendar"
              style="left: 20.83%; width: 4.17%"
            />
            <div
              class="top__concept-bar top__concept-bar--calendar"
              style="left: 50%; width: 8.33%"
            />
            <div
              class="top__concept-bar top__concept-bar--calendar"
              style="left: 66.67%; width: 4.17%"
            />
          </div>
        </div>
        <div class="top__concept-lane">
          <span class="top__concept-label top__concept-label--work">Work</span>
          <div class="top__concept-track">
            <div
              class="top__concept-bar top__concept-bar--work"
              style="left: 8.33%; width: 12.5%"
            />
            <div class="top__concept-bar top__concept-bar--work" style="left: 25%; width: 20.83%" />
            <div
              class="top__concept-bar top__concept-bar--work"
              style="left: 58.33%; width: 8.33%"
            />
            <div class="top__concept-bar top__concept-bar--work" style="left: 75%; width: 8.33%" />
          </div>
        </div>
        <div class="top__concept-overlay">
          <span>起床 <b>07:00</b></span>
          <span>経過 <b>11h 30m</b></span>
          <span>未記録 <b class="top__concept-warn">3h 30m</b></span>
        </div>
      </div>
    </section>

    <section class="top__services">
      <div class="top__services-head">
        <h2>3 つのサービスを、1 つの時間軸に。</h2>
        <p>API トークンを連携すれば、あとは毎日自動で。</p>
      </div>
      <div class="top__services-grid">
        <article class="top__service top__service--sleep">
          <div class="top__service-icon" aria-hidden="true">睡</div>
          <h3>Oura</h3>
          <p>睡眠時間 / 睡眠スコア / Readiness / 起床時刻 / Active calories</p>
        </article>
        <article class="top__service top__service--calendar">
          <div class="top__service-icon" aria-hidden="true">予</div>
          <h3>Google Calendar</h3>
          <p>予定時間合計 / カレンダー別。複数アカウント対応予定</p>
        </article>
        <article class="top__service top__service--work">
          <div class="top__service-icon" aria-hidden="true">作</div>
          <h3>Toggl Track</h3>
          <p>作業時間合計 / タイトル別。プロジェクトタグも反映</p>
        </article>
      </div>
    </section>

    <footer class="top__footer">
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
$color-sleep: #3b4f86;
$color-sleep-bg: #eaeef6;
$color-calendar: #3e7b5a;
$color-calendar-bg: #e5efe8;
$color-work: #c2683a;
$color-work-bg: #f5e7db;
$color-warning: #b7791f;
$font-mono: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;
$font-en:
  "Geist",
  "Inter",
  system-ui,
  -apple-system,
  sans-serif;

.top {
  min-height: 100vh;
  min-height: 100dvh;
  font-family: "Geist", "Noto Sans JP", "Hiragino Sans", sans-serif;
  color: $color-text;
  background: $color-bg;
}

.top__nav {
  padding: 18px 40px;
  display: flex;
  align-items: center;
  border-bottom: 1px solid $color-border;

  @media (max-width: 640px) {
    padding: 14px 20px;
  }
}

.top__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
}

.top__brand-mark {
  width: 28px;
  height: 28px;
  display: grid;
  font-family: $font-en;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  background: #111827;
  border-radius: 8px;
  place-items: center;

  @media (max-width: 640px) {
    width: 24px;
    height: 24px;
    font-size: 11px;
    border-radius: 6px;
  }
}

.top__brand-name {
  font-size: 15px;

  @media (max-width: 640px) {
    font-size: 14px;
  }
}

.top__nav-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.top__nav-link {
  padding: 0 14px;
  height: 36px;
  display: inline-flex;
  justify-content: center;
  align-items: center;
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

.top__nav-cta {
  padding: 0 14px;
  height: 36px;
  display: inline-flex;
  justify-content: center;
  align-items: center;
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

.top__hero {
  margin: 0 auto;
  padding: 80px 40px 64px;
  max-width: 1200px;
  display: grid;
  align-items: center;
  gap: 64px;
  grid-template-columns: 1.1fr 1fr;

  @media (max-width: 1024px) {
    padding: 56px 32px 48px;
    gap: 48px;
    grid-template-columns: 1fr;
  }

  @media (max-width: 640px) {
    padding: 40px 20px 32px;
    gap: 32px;
  }
}

.top__eyebrow {
  margin-bottom: 16px;
  font-family: $font-mono;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: $color-text-muted;
}

.top__title {
  margin-bottom: 20px;
  font-size: 48px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.025em;

  span {
    color: $color-text-muted;
  }

  @media (max-width: 1024px) {
    font-size: 40px;
  }

  @media (max-width: 640px) {
    margin-bottom: 14px;
    font-size: 30px;
    line-height: 1.15;
  }
}

.top__lede {
  margin-bottom: 32px;
  max-width: 480px;
  font-size: 17px;
  line-height: 1.6;
  color: $color-text-muted;

  b {
    font-weight: 600;
    color: $color-text;
  }

  @media (max-width: 640px) {
    margin-bottom: 24px;
    font-size: 14px;
  }
}

.top__cta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;

  @media (max-width: 480px) {
    flex-direction: column;
    gap: 10px;
  }
}

.top__cta-primary {
  padding: 0 28px;
  height: 52px;
  display: inline-flex;
  justify-content: center;
  align-items: center;
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

.top__cta-secondary {
  padding: 0 28px;
  height: 52px;
  display: inline-flex;
  justify-content: center;
  align-items: center;
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

.top__concept {
  padding: 24px;
  background: $color-bg;
  border: 1px solid $color-border;
  border-radius: 16px;
  box-shadow: 0 4px 14px rgba(26, 24, 20, 0.07);

  @media (max-width: 640px) {
    padding: 18px;
  }
}

.top__concept-head {
  margin-bottom: 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: $font-mono;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: $color-text-muted;
}

.top__concept-title {
  font-family: "Geist", "Noto Sans JP", "Hiragino Sans", sans-serif;
  font-size: 13px;
  font-weight: 600;
  color: $color-text;
}

.top__concept-date {
  font-family: $font-mono;
}

.top__concept-axis {
  margin-bottom: 12px;
  margin-left: 70px;
  padding-bottom: 4px;
  display: flex;
  font-family: $font-mono;
  font-size: 10px;
  color: $color-text-muted;
  border-bottom: 1px solid $color-border-2;

  span {
    flex: 1;
  }

  @media (max-width: 640px) {
    margin-left: 56px;
  }
}

.top__concept-lane {
  margin-bottom: 8px;
  display: flex;
  align-items: center;
}

.top__concept-label {
  width: 70px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 500;

  &--sleep {
    color: $color-sleep;
  }
  &--calendar {
    color: $color-calendar;
  }
  &--work {
    color: $color-work;
  }

  @media (max-width: 640px) {
    width: 56px;
    font-size: 10px;
  }
}

.top__concept-track {
  position: relative;
  height: 24px;
  flex: 1;
  background: $color-surface-2;
  border-radius: 4px;

  @media (max-width: 640px) {
    height: 20px;
  }
}

.top__concept-bar {
  position: absolute;
  top: 2px;
  bottom: 2px;
  border-radius: 3px;

  &--sleep {
    background: $color-sleep;
  }
  &--calendar {
    background: $color-calendar;
  }
  &--work {
    background: $color-work;
  }
}

.top__concept-overlay {
  margin-top: 16px;
  padding: 12px 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-family: $font-mono;
  font-size: 11px;
  color: $color-text-muted;
  background: $color-surface;
  border-radius: 8px;

  b {
    font-family: $font-en;
    font-weight: 600;
    color: $color-text;
  }
}

.top__concept-warn {
  color: $color-warning !important;
}

.top__services {
  padding: 64px 40px;
  background: $color-surface;
  border-top: 1px solid $color-border;
  border-bottom: 1px solid $color-border;

  @media (max-width: 640px) {
    padding: 40px 20px;
  }
}

.top__services-head {
  margin-bottom: 40px;
  text-align: center;

  h2 {
    margin-bottom: 8px;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.01em;

    @media (max-width: 640px) {
      font-size: 22px;
    }
  }

  p {
    font-size: 14px;
    color: $color-text-muted;
  }

  @media (max-width: 640px) {
    margin-bottom: 24px;
  }
}

.top__services-grid {
  margin: 0 auto;
  max-width: 980px;
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(3, 1fr);

  @media (max-width: 840px) {
    grid-template-columns: 1fr;
  }
}

.top__service {
  padding: 24px;
  background: $color-bg;
  border: 1px solid $color-border;
  border-radius: 12px;

  h3 {
    margin-bottom: 6px;
    font-size: 15px;
    font-weight: 600;
  }

  p {
    font-size: 13px;
    line-height: 1.6;
    color: $color-text-muted;
  }

  &--sleep .top__service-icon {
    color: $color-sleep;
    background: $color-sleep-bg;
  }
  &--calendar .top__service-icon {
    color: $color-calendar;
    background: $color-calendar-bg;
  }
  &--work .top__service-icon {
    color: $color-work;
    background: $color-work-bg;
  }
}

.top__service-icon {
  margin-bottom: 16px;
  width: 36px;
  height: 36px;
  display: grid;
  font-size: 14px;
  font-weight: 700;
  border-radius: 10px;
  place-items: center;
}

.top__footer {
  padding: 48px 40px;
  display: flex;
  justify-content: space-between;
  font-family: $font-mono;
  font-size: 12px;
  color: $color-text-muted;

  @media (max-width: 640px) {
    padding: 32px 20px;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-align: center;
  }
}
</style>
