# Directory Structure

このプロジェクトのファイルは **「責務」** で説明する。  
「`components/` に何が入っている」ではなく、「**この責務を担うファイルはどこにあるか**」で見つけられるようにする。

> ディレクトリそのものの紹介は [`../../CLAUDE.md`](../../CLAUDE.md) と Nuxt の慣習がベースなので、ここではあえて **責務 → ファイル** の方向で並べる。

---

## 認証

| ファイル | 役割 |
| --- | --- |
| `app/middleware/auth.ts` | 認証必須ページ用 route middleware。未ログインなら `/login` へリダイレクト |
| `app/middleware/require-connections.ts` | `/daily/*` 用補助。Oura / Google 未接続なら `/settings?require_connections=...` へ |
| `server/utils/auth.ts` | Server API での Bearer JWT 検証（`requireUserId`）|
| `server/utils/oauthState.ts` | 外部 OAuth の state 署名 + nonce 検証（CSRF 対策）|
| `app/pages/login.vue` / `app/pages/signup.vue` / `app/pages/auth/callback.vue` | ログイン / サインアップ / OAuth コールバック UI |
| `nuxt.config.ts` の `supabase: { redirect: false }` | `@nuxtjs/supabase` の自動リダイレクトを無効化し、`auth` middleware に一本化 |

**理由**: 認証は「画面側の判定」（middleware）と「サーバ側の検証」（`requireUserId`）の二段構え。両方を統一の Supabase Auth に乗せている。  
詳細は [auth.md](./auth.md) を参照。

---

## サマリー取得 / 表示

| ファイル | 役割 |
| --- | --- |
| `app/pages/daily/[date].vue` | 認証ページ本体。GET → 描画 → stale なら裏で refresh、手動更新ボタン |
| `app/pages/daily/today.vue` | 「Wake-based today」を解決して `/daily/[date]` 相当に描画する |
| `app/pages/demo/daily/[date].vue` | 認証不要のデモ版。`demo_*` テーブルから読む |
| `app/components/DailySummaryView.vue` | 描画の本体（認証 / デモで再利用）|
| `app/utils/wakeBasedToday.ts` | `today` を起床基準で解決するクライアントヘルパ |
| `server/api/summary.get.ts` | `GET /api/summary?date=...` 。DB のみ読む |
| `server/api/demo/summary.get.ts` | デモ用 summary（外部 API を介さない）|
| `server/api/summary/refresh.post.ts` | `POST /api/summary/refresh` 。`refreshUserDate` を呼ぶ薄いラッパ |
| `server/api/cron/daily.get.ts` | Vercel Cron 専用。users × 14 日を `refreshUserDate` で回す |
| `server/utils/wakeRange.ts` | Wake-based Timeline の計算 + `target_date` 算出 + `overlaps` |

**理由**: 「読み (`GET /api/summary`) は DB だけ」「書き (`refresh`) は外部 API を叩く」を厳密に分けている（SPEC §10.1）。同じ DB を読む処理を複数箇所に書かないため、UI 側で再フェッチする時も同じ `/api/summary` を叩く。

---

## 同期 / 外部サービス連携

| ファイル | 役割 |
| --- | --- |
| `server/utils/runRefresh.ts` | 1 user × 1 日付の編成。`refreshUserDate` がエントリポイント |
| `server/utils/syncLock.ts` | `daily_sync_statuses` を使った同期ロック（楽観排他）|
| `server/utils/syncOura.ts` | Oura の取得 → upsert → ソフトデリート |
| `server/utils/syncGoogle.ts` | Google Calendar の取得 → upsert → ソフトデリート（calendar_id ごとの差分処理）|
| `server/utils/syncToggl.ts` | Toggl の取得 → upsert → ソフトデリート |
| `server/utils/getOuraData.ts` | Oura API クライアント（Zod 検証込み）|
| `server/utils/getGoogleData.ts` | Google Calendar API クライアント（差分同期 + calendarList）|
| `server/utils/getTogglData.ts` | Toggl Track API クライアント |
| `server/utils/oauth/oura.ts` | Oura の authorize / token / refresh |
| `server/utils/oauth/google.ts` | Google の authorize / token / refresh（`selectAccount` フラグでピッカー強制）|
| `server/utils/oauth/idTokenVerify.ts` | Google `id_token` の JWKS 検証（`jose`）。`sub` / `email` を取り出す（Issue #131）|
| `server/utils/oauth/redirectUri.ts` | redirect_uri を request origin から組み立てる（Issue #100）|

**理由**: 「外部 API を叩く部分」を **必ず内部モジュール** にして、HTTP エンドポイントとして公開しない（SPEC §9.1 注釈）。これで認証 / 暗号化 / Zod 検証 / レート制御の責務が散らばらない。

---

## トークンと暗号化

| ファイル | 役割 |
| --- | --- |
| `server/utils/crypto.ts` | AES-256-GCM encrypt / decrypt |
| `server/utils/serviceConnection.ts` | `service_connections` テーブルへの upsert / 切断 / トークン取得 / 401 リトライ |
| `server/utils/supabaseAdmin.ts` | RLS bypass 用の admin client（`SUPABASE_SECRET_KEY`）|

**理由**: トークンは「DB に AES-256-GCM で暗号化保存 / 平文はメモリ内のごく短時間 / レスポンスには絶対に乗せない」が原則。これらは server-only のため、クライアントには絶対に exposure させてはいけない。

---

## API 入出力スキーマ

| ファイル | 用途 |
| --- | --- |
| `shared/schemas/common.ts` | enum / プリミティブ（`serviceProviderSchema` / `syncStatusSchema` / `timezoneSchema` / `isoDateSchema` 等）|
| `shared/schemas/errors.ts` | `apiErrorItemSchema`（部分失敗時のエラー項目）|
| `shared/schemas/summary.ts` | `/api/summary` / `/api/summary/refresh` の I/O |
| `shared/schemas/connections.ts` | `/api/connections/*` の I/O |
| `shared/schemas/oura.ts` | Oura API レスポンス検証 |
| `shared/schemas/google.ts` | Google Calendar API レスポンス検証 |
| `shared/schemas/toggl.ts` | Toggl API レスポンス検証 |
| `shared/schemas/index.ts` | barrel export。利用側はここから import |
| `server/utils/validation.ts` | `parseOrThrow` / `parseExternal` ヘルパ |

**理由**: 画面とサーバの両方が同じ Zod スキーマを参照することで、「クライアント側で型を再宣言してズレる」を防ぐ。命名規約は `<対象>Schema` で、`z.infer` した型は `<対象>` をそのまま PascalCase（`CLAUDE.md` Zod 節）。

---

## 状態管理（現状）

| ファイル | 役割 |
| --- | --- |
| `useSupabaseUser` / `useSupabaseClient` | `@nuxtjs/supabase` が提供する composable。セッション参照 |
| `app/pages/daily/[date].vue` 内の `ref` | サマリーデータ / loading / error をローカルに保持 |

**理由**: 現時点で複数ページ間で共有が必要な状態が無い。Pinia は SPEC に書かれているが導入していない（Issue #99 の SSR バンドル事故が直近の理由）。

---

## デザイン / スタイル

| ディレクトリ / ファイル | 役割 |
| --- | --- |
| `design-tone/` | デザインの基準ファイル群。UI 実装時は **必ず** ここを基準にする |
| `app/assets/styles/style.scss` | エントリ。`reset` / `design-tokens` / `variables` / `mixins` を `@use` |
| `app/assets/styles/variables.scss` / `mixins.scss` | 全 SCSS に `additionalData` で自動 inject される（`nuxt.config.ts`）|

**理由**: SCSS 変数 / mixin は **`@use` を書かなくても使える**。これは `nuxt.config.ts` の `vite.css.preprocessorOptions.scss.additionalData` で全 SCSS に prepend しているため。

---

## デプロイ / Cron / 監視

| ファイル | 役割 |
| --- | --- |
| `vercel.json` | Vercel Cron 設定（`0 20 * * *` UTC = 05:00 JST）|
| `.github/workflows/ci-check.yml` | CI（`pnpm lint` / `nuxi typecheck` / `pnpm build`）|
| `sentry.client.config.ts` / `sentry.server.config.ts` | Sentry 初期化 |
| `nuxt.config.ts` の `sentry` セクション | Sentry プラグイン（sourcemap 等）|
| `.nvmrc` | Node 22 固定 |
| `.husky/` | pre-commit hook（lint-staged）|

---

## ドキュメント

| ファイル | 役割 |
| --- | --- |
| `docs/SPEC.md` | 確定版仕様書（**仕様の正**）|
| `docs/spec-rough.md` | 過去ラフ（参考）|
| `docs/designs/` | デザイン関連メモ |
| `docs/personal/` | 個人メモ（git 追跡対象外）|
| `docs/onboarding/` | 当ディレクトリ。オンボーディング |
| `CLAUDE.md` | AI / 人間共通の開発ルール |
| `README.md` | プロジェクトのトップ |

---

## なぜ Nuxt 4 の `app/` ディレクトリ構成なのか

Nuxt 4 では `app/` 配下に `pages/` / `components/` / `layouts/` / `middleware/` をまとめる。`server/` / `shared/` / `public/` はトップレベル。  
これは Nuxt の慣習に乗っかっているだけで、特別な変更はしていない。

---

## ファイルが見つからない時の探し方

| 探したいもの | 手掛かり |
| --- | --- |
| API エンドポイント | `server/api/` を見る。ファイル名 = ルート（`server/api/summary.get.ts` → `GET /api/summary`）|
| 外部 API クライアント | `server/utils/get<Provider>Data.ts` |
| OAuth フロー | `server/utils/oauth/<provider>.ts` + `server/api/connections/<provider>/*.ts` |
| Zod スキーマ | `shared/schemas/<対象>.ts`（`shared/schemas/index.ts` から再 export）|
| ページ | `app/pages/` のディレクトリ構造がそのまま URL |
| middleware | `app/middleware/<name>.ts` を `definePageMeta({ middleware: [...] })` で参照 |
| DB スキーマ | `supabase/migrations/` の SQL を timestamp 順に追う |
| 環境変数の意味 | `CLAUDE.md` の「環境変数」表 |

---

## 次に読むもの

- [data-flow.md](./data-flow.md) — リクエストの流れ
- [feature-map.md](./feature-map.md) — 機能ごとの「触る場所」
