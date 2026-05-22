# UI

このアプリのフロントエンドは **Nuxt 4 + Vue 3 + SCSS**。  
ここでは「**どのページが何を担うか / 共通描画コンポーネントの責務 / SCSS の使い方**」を説明する。

---

## ページ構成

### 公開ページ（認証不要）

| ルート | ファイル | 役割 |
| --- | --- | --- |
| `/` | `app/pages/index.vue` | トップ。プロダクト紹介 |
| `/login` | `app/pages/login.vue` | ログイン（Google OAuth + Email）|
| `/signup` | `app/pages/signup.vue` | サインアップ |
| `/auth/callback` | `app/pages/auth/callback.vue` | OAuth / magic link callback |
| `/demo` | `app/pages/demo/index.vue` | デモエントリ |
| `/demo/daily/[date]` | `app/pages/demo/daily/[date].vue` | デモ日次詳細（`demo_*` テーブル）|

### 認証必須ページ

| ルート | ファイル | 役割 |
| --- | --- | --- |
| `/daily/[date]` | `app/pages/daily/[date].vue` | 日次詳細（Today's ME + Timeline）|
| `/daily/today` | `app/pages/daily/today.vue` | Wake-based today へリダイレクト |
| `/settings` | `app/pages/settings.vue` | サービス連携 / 除外カレンダー設定 |

---

## ページの責務分担

### `/daily/[date].vue` （認証ページ本体）

```ts
definePageMeta({ middleware: ["auth", "require-connections"] });
```

責務:
- date の妥当性検証（`isoDateSchema` で実在日もチェック）。
- Bearer ヘッダの組み立て。
- `/api/summary` のフェッチ / レース防御（`activeRequestId`）。
- stale 判定 → background refresh。
- 手動更新ボタンのハンドリング。

描画はすべて **`DailySummaryView`** に委譲する。

### `/daily/today.vue`

責務:
- `fetchWakeBasedToday()` で「自分にとっての今日」を解決。
- 結果に基づいて `/daily/<YYYY-MM-DD>` に navigate。

### `/demo/daily/[date].vue`

責務:
- 認証不要。`/api/demo/summary` を叩いて `demo_*` テーブルからデータを取る。
- 同じ **`DailySummaryView`** で描画（コンポーネント再利用）。

### `/settings.vue`

責務:
- `/api/connections` を読んで連携状況を表示。
- Oura / Google の「接続」ボタン → `start` API → 認可画面へリダイレクト。
- Toggl は API token 入力フォーム → `POST /api/connections/toggl`。
- Google カレンダー除外設定: チェックボックスでドラフト編集 → 「保存」ボタンで `PUT /api/connections/google/excluded-calendars`。

---

## コンポーネント構成

現在のコンポーネントは **1 つだけ**:

| コンポーネント | 責務 |
| --- | --- |
| `DailySummaryView.vue` | Today's ME と Wake-based Timeline の描画本体。認証 / デモで再利用 |

**なぜコンポーネントが少ないのか**: ページ数自体が少なく、ページ間で共有が必要な UI が `DailySummaryView` 以外に無いから。将来 Timeline の lane を別出ししたくなれば `app/components/timeline/<lane>.vue` のような構造に育てる。

### `DailySummaryView` の責務境界

- `props.summary: SummaryResponse | null` を受け取り、見た目を組み立てる。
- `props.loading` / `props.errorMessage` / `props.dateParam` / `props.basePath` で描画状態を制御。
- `<slot name="topbar-action">` で「更新」「設定」のような **認証ページ固有のアクション** をページから差し込む。
- データフェッチや refresh のロジックは持たない（ページの責務）。

---

## レイアウト

| ファイル | 役割 |
| --- | --- |
| `app/layouts/default.vue` | デフォルトレイアウト |
| `app/app.vue` | ルート。SEO メタ / OGP 設定 / `<NuxtLayout><NuxtPage /></NuxtLayout>` |

`/auth/callback` は `definePageMeta({ layout: false })` でレイアウトを外している（フォーム要素がほぼ無い、認証完了の一瞬しか描画されないため）。

---

## SCSS

### エントリと自動 inject

`nuxt.config.ts`:

```ts
vite: {
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `
        @use "sass:color";
        @use "~/assets/styles/variables" as *;
        @use "~/assets/styles/mixins" as *;
        `,
      },
    },
  },
},
css: ["~/assets/styles/style.scss"],
```

- `variables` / `mixins` は **全 SCSS に自動で prepend** される。各 .vue ファイルや .scss ファイルで `@use` しなくて良い。
- `style.scss` は `reset` / `design-tokens` / `variables` / `mixins` を `@use` するエントリ。

### スタイルファイル

| ファイル | 役割 |
| --- | --- |
| `app/assets/styles/reset.scss` | CSS リセット |
| `app/assets/styles/design-tokens.scss` | 色 / spacing / typography トークン |
| `app/assets/styles/variables.scss` | SCSS 変数（自動 inject 経由で使う）|
| `app/assets/styles/mixins.scss` | SCSS mixin |
| `app/assets/styles/style.scss` | エントリ |
| `app/assets/styles/images/` | UI で使う画像（サービスアイコン等）|

### コンパイル

- 開発時: Vite の SCSS preprocessor がオンザフライでコンパイル。
- `pnpm sass`（CLAUDE.md 記載）: UI 実装後・テスト前に走らせる。ただし **worktree で並行作業する時はコンパイルしない**（複数 worktree でコンパイル後 `style.css` を作るとコンフリクトする）。

---

## デザイントーン

UI 実装時は **必ず** `desine-tone/` の内容をベースにする（CLAUDE.md「UI 実装時」節）。独自にトーンを作らない。

- `desine-tone/uploads/` / `desine-tone/shared/` / `desine-tone/pages/` にデザインのリファレンス。
- 配色 / spacing / typography はここから取る。

---

## UI 動作確認

CLAUDE.md より:
- UI を実装したら **Playwright MCP（ブラウザ操作）で必ず動作確認**。
- テストファイル（`*.spec.ts` / `tests/`）は **明示指示が無い限り作らない**（Issue #63）。
- 実行できない場合は省略せず **ユーザーに確認**。

確認のチェックリスト（典型）:
- [ ] golden path（最も使われる経路）が動く
- [ ] エッジケース（空データ / エラー / 過去日 / 進行中エントリ）も崩れない
- [ ] PC（1440px） / タブレット（820px） / SP（375px）でレイアウトが破綻しない
- [ ] 既存機能の regression が無い

---

## アイコン

`/daily/[date].vue` の「更新」「設定」ボタンは **Material Symbols Outlined** を使っている:

```html
<head>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:...">
</head>
```

- 使う側は `<span class="material-symbols-outlined">refresh</span>` のようにアイコン名を中身に書く。
- spin アニメーションは `&--spin { animation: ... infinite; }` でクラス切り替え。

---

## 既存ページのスタイル方針（観察事項）

`/daily/[date].vue` の `<style lang="scss" scoped>` には、ローカル変数（`$color-text` 等）を **そのページ固有のスコープで** 宣言している。`desine-tone/` 由来の色と矛盾しないことを実装時に確認すること。

「**認証ページ固有の見た目**」を `DailySummaryView` に持ち込まず、ページ側で `<slot>` を埋めるパターンは、デモと認証で `DailySummaryView` を再利用するために重要。

---

## SEO / OGP

`app/app.vue` で `useSeoMeta` / `useHead` を設定:
- `og:image` は `/ogp-rectangle.png`（1731×909）と `/ogp-square.png`（1254×1254）の 2 種類。
- `twitter:card` は `summary_large_image`。
- `lang="ja"` を `<html>` に。

---

## 変更時の注意点

- 新規ページ追加時:
  - [ ] 認証必須なら `definePageMeta({ middleware: ["auth"] })` を必ず書く（`/daily/*` は `"require-connections"` も）。
  - [ ] デザインは `desine-tone/` を基準にする。
  - [ ] UI 実装後 Playwright MCP で動作確認。
- SCSS:
  - [ ] `@use` を書かなくても `variables` / `mixins` は使える（自動 inject）。
  - [ ] worktree でコンパイル後 `style.css` を生成しない（コンフリクト）。
- コンポーネント分割:
  - [ ] データフェッチや refresh は **ページの責務**。コンポーネントは props で受け取って描画するだけにする。

---

## 次に読むもの

- [state-management.md](./state-management.md) — UI 状態の置き場所
- [data-flow.md](./data-flow.md) — 描画までのデータの流れ
