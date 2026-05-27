# Glossary

このプロジェクトでよく出てくる用語を「**業界一般の意味** / **このプロジェクトでの特化した意味**」の順で整理する。

---

## 業務 / プロダクト用語

### Today's ME

プロダクト名。Oura（睡眠）/ Google Calendar（予定）/ Toggl Track（作業ログ）を 1 つの時間軸に統合する個人向けダッシュボード。

### Wake-based Timeline

**1 日を「前回起床から次の睡眠（または現在）まで」で扱う考え方**。`00:00–24:00` ではない（SPEC §2）。

- 当日: 前回起床 → 現在
- 過去日: 前回起床 → 次の睡眠開始

### `target_date`

レコードが「どの日のもの」として扱われるかを示す `date` 型カラム。  
**Oura sleep の場合は `wake_at` の日付**（ユーザータイムゾーン基準）に紐づける。睡眠開始日ではない（SPEC §2 / Issue #24）。

### Wake range

`{ start: Date, end: Date }`。Wake-based Timeline の表示範囲。`server/utils/wakeRange.ts:wakeRangeOf` で計算する。

### Today's ME（UI 側）

画面の上半分に表示される **日次サマリーカード群**。各サービスごとの集計（睡眠時間 / 予定時間 / 作業時間など）。SPEC §4.1。

### Wake-based Timeline（UI 側）

画面の下半分に表示される **3 レーンの時間軸**（Sleep / Calendar / Work）。wake range と各レコードの `start_at`/`end_at` の重なりで表示判定する。

### Stale

当日かつ `daily_sync_statuses.last_synced_at` が **30 分以上古い** 状態。stale なら背後で `POST /api/summary/refresh` を呼ぶ（SPEC §10.2）。

### Sync status

`daily_sync_statuses` テーブルで管理される (user × target_date × source) ごとの同期状態。`idle` / `in_progress` / `success` / `failed`。

### `needs_reauth`

`service_connections.status` の 4 値目（Issue #131 Phase 2）。複数 Google アカウント連携を導入するにあたって、旧 Google 接続行（`provider_user_id` 未取得）に貼られる過渡状態。`/settings` バナーから再認可を踏むと callback が `id_token.sub` / `email` を backfill して `connected` に戻る。

### Sync lock

`daily_sync_statuses` の `unique(user_id, target_date, source)` 行を条件付き UPDATE して `status = in_progress` に切り替えることで多重実行を防ぐ仕組み。`server/utils/syncLock.ts`。

### Stale lock

`sync_started_at` が **10 分** より古い `in_progress` ロック。process 落ち等で回収不能になったロックを次の `tryAcquireSyncLock` が奪える。

### lockId

奪取時に書き込んだ `sync_started_at` の値。`markSyncSuccess` / `markSyncFailed` の WHERE 条件に含めて「自分の lock だけ更新」を保証する owner key。

### ソフトデリート

`is_deleted = true` で削除済みマークを付け、物理削除しない（SPEC §11.3）。読み取り側は `eq("is_deleted", false)` で絞る。

### 部分失敗（partial failure）

Oura / Google / Toggl の sync のうち 1 つが失敗しても他は続行する設計（SPEC §9.2）。

---

## 技術用語

### RLS（Row Level Security）

PostgreSQL の行レベルアクセス制御。`auth.uid() = user_id` のポリシーで「自分の行だけ」見せる。`alter table ... enable row level security` + `create policy ...`。

### `auth.uid()`

Supabase Auth が JWT から取り出した user id。RLS ポリシー内で参照できる。

### `auth.users` / `public.users`

- `auth.users`: Supabase Auth が管理するシステムテーブル。
- `public.users`: アプリ固有のプロファイル（`timezone` 等）。**両者は 1:1**。`handle_new_user()` トリガが auto INSERT する。

### Bearer 認証

`Authorization: Bearer <jwt>` ヘッダで認証する方式。このアプリでは Server API の認証の基本。CSRF 対策として cookie 認証フォールバックは限定的（`/api/internal/connections-required` と SSR 経由の `/api/summary` 系のみ / `requireUserIdAllowCookie`）。

### `provider_user_id`

`service_connections` の列。Google は `id_token.sub` を JWKS 検証して保存する（Issue #131 Phase 2）。複数アカウント連携の識別キーで、`(user_id, provider, provider_user_id)` の partial unique で別行を区別する。Oura / Toggl は使わない。

### `account_email`

`service_connections` の列。Google `id_token.email` を保存する。`/settings` で「どのアカウントか」を識別表示する用途と、同名カレンダーの集計衝突解決（`"<name> (<email>)"` 接尾辞）に使う。

### `connection_id`（Google）

`service_connections.id` を `google_calendar_events` / `google_excluded_calendars` に貼り付けたもの（Issue #131 Phase 4 / Phase 5）。複数 Google アカウント連携でイベント / 除外設定を接続単位にスコープするためのキー。同期 sweep もすべてこのキーで絞る。

### OAuth2

外部サービス（Oura / Google）の認可フロー。`authorize → callback → token exchange → refresh` の 4 段階。

### OAuth state

OAuth2 の `state` パラメータ。CSRF 対策で「`{uid, nonce, exp}` を HMAC-SHA256 で署名 + nonce を cookie と突き合わせ + 10 分で expire」している（`server/utils/oauthState.ts`）。

### `withFreshAccessToken`

`server/utils/serviceConnection.ts` の高階関数。`fn(accessToken)` を呼び、401 を受けたら 1 回だけ refresh + retry する。

### `getValidAccessToken`

トークン取得 + 期限が 5 分以内なら事前 refresh する関数。`withFreshAccessToken` の内部でも呼ばれる。

### `parseOrThrow` / `parseExternal`

`server/utils/validation.ts` の Zod ラッパ。

- `parseOrThrow`: 失敗時 400（または指定 code）。内部 I/O の検証用。
- `parseExternal`: 失敗時 502 + `InvalidExternalResponse:<service>`。外部 API レスポンス検証用。

### `supabaseAdmin`

RLS を bypass する admin client（`getSupabaseAdmin()`）。`SUPABASE_SECRET_KEY` を使う。サーバ側でのみ使用可能。

### Wake-based today

ユーザーの「自分にとっての今日」。最新の `oura_sleep_records.wake_at` の日付（`fetchWakeBasedToday`）。深夜まだ寝ていなければ「昨日」扱いになる。

### Demo テーブル

`demo_oura_sleep_records` / `demo_google_calendar_events` / `demo_toggl_time_entries` 等。**本番テーブルと完全分離** された公開デモ用テーブル。認証不要・外部 API 不要で読める。

---

## ファイル / モジュール名

### `runRefresh.ts`

**1 user × 1 日付 の refresh 編成の唯一の入り口**。`/api/summary/refresh` も `/api/cron/daily` もここを呼ぶ。`server/utils/runRefresh.ts:refreshUserDate`。

### `syncLock.ts`

同期ロックの実装（`tryAcquireSyncLock` / `markSyncSuccess` / `markSyncFailed`）。

### `serviceConnection.ts`

`service_connections` テーブルへの upsert / トークン取得 / 401 retry / refresh エラー処理を担う中核。Google 用ヘルパとして `listConnectedGoogleConnections` / `withFreshAccessTokenByConnection` / `disconnectGoogleConnectionById` / `deleteGoogleConnectionPermanently` がある（Issue #131）。

### `idTokenVerify.ts`

`server/utils/oauth/idTokenVerify.ts`。Google `id_token` の JWKS 検証（`jose` の `createRemoteJWKSet`）。callback で `sub` / `email` を取り出して `service_connections.provider_user_id` / `account_email` を埋めるために使う（Issue #131 Phase 2）。

### `crypto.ts`

AES-256-GCM の `encrypt` / `decrypt`。`server/utils/crypto.ts`。

### `wakeRange.ts`

- `targetDateOf(wakeAt, timezone)` … wake_at の日付を YYYY-MM-DD で返す（ICU 依存を避ける実装）。
- `wakeRangeOf(date, userId, ...)` … Supabase から sleep を読んで wake range を組み立てる。
- `computeWakeRange(...)` … 純粋関数版。
- `overlaps(range, start, end)` … 範囲と重なるか。

### `wakeBasedToday.ts`

クライアント側 wakeRange の最小版。`app/utils/wakeBasedToday.ts:fetchWakeBasedToday`。

### `runtimeConfig.public`

Nuxt の設定で、クライアントバンドルにインライン化される値。`NUXT_PUBLIC_*` 環境変数のみ入れる。

### `additionalData`（SCSS）

`nuxt.config.ts` で全 SCSS に prepend される文字列。`variables` / `mixins` を `@use` で自動 inject。

### `definePageMeta`

Nuxt のページメタ宣言。`middleware` / `layout` 等を指定する。

---

## 外部サービス用語

### Oura

- **Daily sleep**: その日の総睡眠サマリー。
- **Sleep**: 個別の睡眠セッション。`wake_at` で「起床日」が決まる。
- **Daily readiness**: その日のリードネス（休息度）。MVP では未使用。
- **Daily activity**: 活動量。MVP では未使用。

### Google Calendar

- **Calendar**: ユーザーが持つ複数のカレンダー。
- **Calendar list**: ユーザーが見えるカレンダーの一覧（`calendarList.list`）。
- **Event**: 予定。`event.id` は **カレンダー内ユニーク**（カレンダー跨ぎでは衝突しうる）。
- **`summaryOverride` / `summary`**: イベントの「タイトル」と「カレンダーの表示名」。このプロジェクトでは calendar の `summaryOverride > summary` を `calendar_name` に採用。
- **`syncToken`**: 差分同期用トークン。MVP では永続化しない。

### Toggl

- **Time entry**: 作業ログ。タイトル / project_id / 開始 / 終了。
- **Workspace**: Toggl のチーム単位。MVP では `/me/time_entries` で全 workspace を取る。
- **`since` watermark**: 差分取得用の Unix 秒。

---

## CSRF / セキュリティ用語

### CSRF（Cross-Site Request Forgery）

ユーザーがログイン状態のまま、別サイトから誘導されて意図しないリクエストを送らされる攻撃。  
このアプリの **OAuth start を cookie 認証で公開する** とこの脆弱性が出るため、Bearer 認証に統一している（[auth.md](./auth.md) 参照）。

### `timingSafeEqual`

タイミング攻撃に強い文字列比較。`node:crypto` の `timingSafeEqual` を使う（`server/utils/oauthState.ts`）。

### AES-256-GCM

対称鍵認証付き暗号方式。`iv` / `authTag` / `ciphertext` の 3 つを保管する（`server/utils/crypto.ts`）。

### HMAC-SHA256

鍵付きハッシュ。OAuth state の署名に使用。

---

## Nuxt 用語（リマインダー）

| 用語                                    | 意味                                       |
| --------------------------------------- | ------------------------------------------ |
| `definePageMeta`                        | ページのメタ（middleware / layout / etc.） |
| `defineEventHandler`                    | server route のハンドラ定義                |
| `useSeoMeta` / `useHead`                | `<head>` の編集                            |
| `useSupabaseUser` / `useSupabaseClient` | `@nuxtjs/supabase` の composable           |
| `$fetch`                                | Nuxt の HTTP クライアント                  |
| `useState`                              | SSR-safe な共有 ref                        |
| `app/`                                  | Nuxt 4 の app ディレクトリ                 |
| `server/api/`                           | server routes（HTTP 公開）                 |
| `server/utils/`                         | server 内部モジュール（HTTP 公開しない）   |
| `shared/`                               | 画面とサーバの両方が import する場所       |
| `middleware/`                           | route middleware                           |
| `~/` または `~~/`                       | path alias（プロジェクトルート相対）       |

---

## 次に読むもの

- [README.md](./README.md) — 全体像
- [architecture-overview.md](./architecture-overview.md) — 責務分割
