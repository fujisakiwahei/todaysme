# Feature Map

「**この機能を直したい時、どこを触ればいいか**」を逆引きするドキュメント。  
新しく入った人が機能修正に取り掛かる時、最初に開く。

> 各機能ごとに「関係箇所」「依存」「変更影響」をまとめる。  
> ファイルパスはコードの正に追従するため、実際に編集する前に grep で確認すること。

---

## 機能一覧

| 機能                                                                            | 主な触る場所                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ログイン / サインアップ](#ログイン--サインアップ)                              | `app/pages/login.vue` / `signup.vue` / `auth/callback.vue`                                                                                                          |
| [ログアウト](#ログアウト)                                                       | `app/pages/settings.vue` / Supabase SDK                                                                                                                             |
| [Today's ME（日次サマリー）](#todays-me日次サマリー)                            | `server/api/summary.get.ts` / `app/components/DailySummaryView.vue`                                                                                                 |
| [Wake-based Timeline](#wake-based-timeline)                                     | `server/utils/wakeRange.ts` / `server/api/summary.get.ts` / `DailySummaryView.vue`                                                                                  |
| [Wake-based today の解決](#wake-based-today-の解決)                             | `app/utils/wakeBasedToday.ts` / `app/pages/daily/today.vue`                                                                                                         |
| [手動更新ボタン](#手動更新ボタン)                                               | `app/pages/daily/[date].vue` / `server/api/summary/refresh.post.ts`                                                                                                 |
| [バックグラウンド自動更新（30 分 stale）](#バックグラウンド自動更新30-分-stale) | `app/pages/daily/[date].vue`                                                                                                                                        |
| [毎朝 5 時の自動同期](#毎朝-5-時の自動同期)                                     | `vercel.json` / `server/api/cron/daily.get.ts`                                                                                                                      |
| [Oura 連携](#oura-連携)                                                         | `server/utils/oauth/oura.ts` / `getOuraData.ts` / `syncOura.ts` / `connections/oura/`                                                                               |
| [Google Calendar 連携](#google-calendar-連携)                                   | `server/utils/oauth/google.ts` / `oauth/idTokenVerify.ts` / `getGoogleData.ts` / `syncGoogle.ts` / `connections/google/`                                            |
| [複数 Google アカウント連携](#複数-google-アカウント連携)                       | `server/api/connections/google/accounts.get.ts` / `start.get.ts (intent=add)` / `[connectionId].delete.ts` / `serviceConnection.ts:listConnectedGoogleConnections`  |
| [Toggl Track 連携](#toggl-track-連携)                                           | `server/api/connections/toggl.post.ts` / `getTogglData.ts` / `syncToggl.ts`                                                                                         |
| [連携の切断](#連携の切断)                                                       | `server/api/connections/[provider].delete.ts` / `connections/google/[connectionId].delete.ts` / `serviceConnection.ts`                                              |
| [Google アカウントのハード削除](#google-アカウントのハード削除)                 | `server/api/connections/google/[connectionId]/account.delete.ts` / `serviceConnection.ts:deleteGoogleConnectionPermanently`                                         |
| [Google カレンダー除外設定（接続単位）](#google-カレンダー除外設定接続単位)     | `app/pages/settings.vue` / `server/api/connections/google/excluded-calendars.put.ts` / `calendars.get.ts` / `summary.get.ts` / `google_excluded_calendars` テーブル |
| [タイムゾーン設定](#タイムゾーン設定)                                           | `app/pages/settings.vue` / `users.timezone`                                                                                                                         |
| [トークン暗号化保存](#トークン暗号化保存)                                       | `server/utils/crypto.ts` / `serviceConnection.ts`                                                                                                                   |
| [401 リトライ](#401-リトライ)                                                   | `server/utils/serviceConnection.ts:withFreshAccessToken`                                                                                                            |
| [同期ロック](#同期ロック)                                                       | `server/utils/syncLock.ts`                                                                                                                                          |
| [部分失敗ハンドリング](#部分失敗ハンドリング)                                   | `server/utils/runRefresh.ts`                                                                                                                                        |
| [公開デモ](#公開デモ)                                                           | `app/pages/demo/` / `server/api/demo/summary.get.ts` / `demo_*` テーブル                                                                                            |
| [require-connections ガード](#require-connections-ガード)                       | `app/middleware/require-connections.ts` / `server/api/internal/connections-required.get.ts`                                                                         |
| [エラートラッキング](#エラートラッキング)                                       | `sentry.*.config.ts` / `nuxt.config.ts`                                                                                                                             |

---

## ログイン / サインアップ

**関係箇所**:

- `app/pages/login.vue`
- `app/pages/signup.vue`
- `app/pages/auth/callback.vue`
- `nuxt.config.ts`（`supabase: { redirect: false }`）

**依存**:

- Supabase Auth（クラウド側でプロバイダ設定）
- `@nuxtjs/supabase`
- Google OAuth client（Supabase 側で Google を有効化済み前提）

**変更影響**:

- ログイン後の遷移先を変える → `resolveNext()` または ページの `navigateTo` を編集。
- `redirectTo` の検証は `/` 始まりの安全な path のみ許容（オープンリダイレクト防御）。

---

## ログアウト

**関係箇所**:

- `app/pages/settings.vue`（ログアウト UI）
- `useSupabaseClient().auth.signOut()`

**依存**: Supabase SDK。

---

## Today's ME（日次サマリー）

**関係箇所**:

- `server/api/summary.get.ts`（集計ロジック）
- `app/components/DailySummaryView.vue`（描画）
- `app/pages/daily/[date].vue`（ページ）
- `shared/schemas/summary.ts`（I/O スキーマ）

**依存**:

- `oura_sleep_records` / `google_calendar_events` / `toggl_time_entries`
- `service_connections`（連携状況判定）
- `users.timezone` / `users.excluded_google_calendar_ids`
- `wakeRangeOf` / `overlaps` / `targetDateOf`

**変更影響**:

- 新しいカード（例: readiness）を追加するなら:
  1. `oura_sleep_records` または新規テーブルに値を保存できる構造を作る。
  2. `summary.get.ts` で集計。
  3. `shared/schemas/summary.ts` の `todaysMeOuraSchema` 等にフィールド追加。
  4. `DailySummaryView.vue` に描画追加。
- Google 集計: 除外カレンダーは `google_excluded_calendars` テーブル（`(connection_id, calendar_id)`）を参照。複数アカウントで同名カレンダーが衝突したら `"<name> (<email>)"` の接尾辞でラベルを分ける（Phase 7）。
- **`meeting_minutes` は廃止された**（Issue #151）。カレンダー名で会議を機械的に分類するのが本番運用に合わなかったため。`MEETING_CALENDAR_NAMES` 定数も削除済み。

---

## Wake-based Timeline

**関係箇所**:

- `server/utils/wakeRange.ts`（`wakeRangeOf` / `computeWakeRange` / `overlaps`）
- `server/api/summary.get.ts`（DB から wake range と重なるレコードを読む）
- `app/components/DailySummaryView.vue`（描画）
- `shared/schemas/summary.ts`（`timelineSchema`）

**依存**: `oura_sleep_records.sleep_start_at` / `wake_at`、`users.timezone`。

**変更影響**:

- Wake range の境界条件を変える → `computeWakeRange` を編集。テストでの境界確認を慎重に。
- 新しいレーン（例: HRV）を追加するなら:
  1. 新規テーブル + sync を追加。
  2. `timelineSchema` にレーンを追加。
  3. `summary.get.ts` で wake range と overlap するレコードを読む。
  4. `DailySummaryView.vue` にレーン UI を追加。

---

## Wake-based today の解決

**関係箇所**:

- `app/utils/wakeBasedToday.ts`
- `app/pages/daily/today.vue`

**依存**: `oura_sleep_records` の最新 1 件、`users.timezone`。

**変更影響**:

- Oura 未連携 fallback は今 `targetDateInTimezone(new Date(), timezone)` のカレンダー日付。挙動を変えたい時はここ。

---

## 手動更新ボタン

**関係箇所**:

- `app/pages/daily/[date].vue`（`manualRefresh()`）
- `server/api/summary/refresh.post.ts`
- `server/utils/runRefresh.ts`

**依存**: `daily_sync_statuses`（ロック）、各サービスの sync runner。

**変更影響**:

- 一度押したら他のページ遷移をブロックしたい等 UX 変更はページ側。
- 同期そのものの挙動変更は `runRefresh.ts` または `sync<Provider>ForDate`。
- **3 provider は `Promise.allSettled` で並列実行**（Issue #140）。新しい provider を足す時は `RUNNERS` テーブルに追加するだけで並列化に乗る。
- Google は `connection_id` 単位のループで sync する（Issue #131 Phase 4）。`listConnectedGoogleConnections` の結果を順に回す。

---

## バックグラウンド自動更新（30 分 stale）

**関係箇所**:

- `app/pages/daily/[date].vue`（`STALE_MS` / `isStale` / `backgroundRefreshIfStale`）

**変更影響**:

- 閾値を変える → `STALE_MS`。
- 過去日でも裏で refresh したい場合は仕様違反（SPEC §10.2）。要 SPEC 改訂。

---

## 毎朝 5 時の自動同期

**関係箇所**:

- `vercel.json`（cron スケジュール）
- `server/api/cron/daily.get.ts`
- `server/utils/runRefresh.ts`

**依存**: `CRON_SECRET` env、`users` テーブル全件、`service_connections`。

**変更影響**:

- 14 日 → N 日にしたい場合 → `REFRESH_DAYS` 定数。Vercel Function の 15 分制限に注意。
- 実行時刻変更 → `vercel.json` の `schedule`（**UTC** で書く）。
- 並列化 → 現状 user × 日付の純粋シリアル。並列にするなら Vercel Functions 単位の Concurrency を考慮。

---

## Oura 連携

**関係箇所**:

- `server/utils/oauth/oura.ts`（authorize / token / refresh）
- `server/utils/getOuraData.ts`（API クライアント）
- `server/utils/syncOura.ts`（upsert + ソフトデリート）
- `server/api/connections/oura/start.get.ts` / `callback.get.ts`
- `shared/schemas/oura.ts`

**依存**: `OURA_CLIENT_ID` / `OURA_CLIENT_SECRET`、Oura API v2、`oura_sleep_records` テーブル。

**変更影響**:

- スコープ追加 → `oauth/oura.ts` + Oura 側設定 + DB マイグレーション（readiness 用テーブル等）。
- レスポンス仕様変化 → `shared/schemas/oura.ts` を更新。検証失敗時は 502 / `InvalidExternalResponse:oura`。

---

## Google Calendar 連携

**関係箇所**:

- `server/utils/oauth/google.ts`（authorize / token / refresh + `selectAccount` フラグ）
- `server/utils/oauth/idTokenVerify.ts`（`id_token` の JWKS 検証 / `jose`）
- `server/utils/oauth/redirectUri.ts`（origin から組み立て）
- `server/utils/getGoogleData.ts`
- `server/utils/syncGoogle.ts`（接続単位で upsert + soft-delete）
- `server/api/connections/google/start.get.ts` / `callback.get.ts` / `calendars.get.ts` / `accounts.get.ts`
- `server/api/connections/google/[connectionId].delete.ts` / `[connectionId]/account.delete.ts`
- `shared/schemas/google.ts` / `shared/schemas/connections.ts`

**依存**: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`、`google_calendar_events`（`connection_id` を持つ）、`google_excluded_calendars` テーブル。

**変更影響**:

- スコープ追加 → `GOOGLE_SCOPES` + Google Cloud Console。**`openid` / `email` は `id_token` の `sub` / `email` を得るために必須**（Phase 2）。
- `redirect_uri_mismatch` → Google Cloud Console の登録 URI を確認（Preview ドメイン）。
- 差分同期（`syncToken`）を本気で導入する場合は永続化先（`service_connections.scopes` ではない別カラム / 別テーブル）を新設する必要あり。
- 同期コード（`syncGoogleForDate`）は **必ず `connection_id` を引数に取り、すべての sweep を `connection_id` でスコープ** する。これを破ると別アカウントのイベントを巻き込んで誤削除する。

---

## 複数 Google アカウント連携

**関係箇所**:

- `server/api/connections/google/accounts.get.ts`（接続行一覧）
- `server/api/connections/google/start.get.ts`（`?intent=add` でアカウントピッカーを強制）
- `server/api/connections/google/callback.get.ts`（`id_token.sub` で既存行を引いて UPDATE or INSERT）
- `server/utils/serviceConnection.ts:listConnectedGoogleConnections` / `upsertServiceConnection`
- `server/utils/oauth/idTokenVerify.ts`
- `app/pages/settings.vue` の Google セクション
- 設計メモ: `docs/designs/multi-google-account.md`

**依存**: `service_connections`（`provider_user_id` / `account_email` / `status='needs_reauth'` / partial unique 2 本）、`google_calendar_events.connection_id`、`google_excluded_calendars`。

**変更影響**:

- アカウント識別キーは `provider_user_id`（= `id_token.sub`）。`account_email` は表示用のみで識別には使わない。
- `provider_user_id` 未取得の旧 Google 行は `status='needs_reauth'`。`/settings` のバナーから再認可で `connected` に戻る（Phase 2）。
- アカウントを追加する UI は `GET /api/connections/google/start?intent=add` を叩く。同じ `sub` を再認可した場合は UPDATE 経路に倒れる（重複行を作らない）。

---

## Toggl Track 連携

**関係箇所**:

- `server/api/connections/toggl.post.ts`（API token 受け取り）
- `server/utils/getTogglData.ts`
- `server/utils/syncToggl.ts`
- `shared/schemas/toggl.ts`

**依存**: ユーザーが Toggl Profile で発行した API token、`toggl_time_entries` テーブル（`project_id` / `project_name` を含む）。

**変更影響**:

- OAuth へ移行する場合は `server/utils/oauth/toggl.ts` を新設。`withFreshAccessToken` の Toggl 分岐も変更。
- **プロジェクト名の解決**（Issue #112）: `/me/time_entries` には `project_id` しか載らないので `syncToggl.ts` で `/me/projects` を別途叩いて id→name のマップを作り、time entry 行に貼り付ける。Toggl 側でリネームされても次回 sync で上書き。

---

## 連携の切断

**関係箇所**:

- `server/api/connections/[provider].delete.ts`（Oura / Toggl 用）
- `server/api/connections/google/[connectionId].delete.ts`（Google: 接続 ID 単位 / Issue #131 Phase 6）
- `server/utils/serviceConnection.ts:disconnectServiceConnection` / `disconnectGoogleConnectionById`

**変更影響**:

- Oura / Toggl は provider 単位、Google は connection_id 単位。同じ「ソフト切断」でも経路が違う。
- Google の soft disconnect は `google_calendar_events` を `is_deleted=true` にも倒すが、`google_excluded_calendars` は残す（再認可で同じ `provider_user_id` に紐づき直ったときに設定を引き継ぐため）。

---

## Google アカウントのハード削除

**関係箇所**:

- `server/api/connections/google/[connectionId]/account.delete.ts`
- `server/utils/serviceConnection.ts:deleteGoogleConnectionPermanently`
- `app/pages/settings.vue`（disconnected な接続カードに「完全に削除」ボタン）

**変更影響**:

- 接続行を物理削除する。`google_calendar_events` / `google_excluded_calendars` は FK の `ON DELETE CASCADE` で巻き取られる。
- UI 側は soft disconnect を踏んでから本エンドポイントを叩く運用（disconnected な行に対してのみ「完全に削除」を出す）。

---

## Google カレンダー除外設定（接続単位）

**関係箇所**:

- `app/pages/settings.vue`（接続カードごとのチェックボックス UI / 保存ボタン）
- `server/api/connections/google/calendars.get.ts`（`?connection_id=...` でカレンダー一覧取得）
- `server/api/connections/google/excluded-calendars.put.ts`（保存）
- `server/api/summary.get.ts`（集計除外 / `is_excluded` フラグ付与）
- `google_excluded_calendars` テーブル（`(connection_id, calendar_id)` 主キー / Issue #131 Phase 5）

**変更影響**:

- 旧仕様の `users.excluded_google_calendar_ids` 配列は **使わない**（列はロールバック用に残る）。除外判定キーは `${connection_id}|${calendar_id}` の合成文字列。
- 除外 + 集計 + UI の 3 箇所に手を入れる必要がある。Issue #131 Phase 5 のコミットを辿ると差分が掴みやすい。

---

## タイムゾーン設定

**関係箇所**:

- `app/pages/settings.vue`
- `users.timezone`
- `server/utils/wakeRange.ts:targetDateOf`
- `server/api/cron/daily.get.ts:resolveTimezone`

**変更影響**:

- ユーザーがタイムゾーンを変える → 過去レコードの `target_date` は再計算されないので、次の sync で自然に更新される（あるいは migration で再算する選択肢）。

---

## トークン暗号化保存

**関係箇所**:

- `server/utils/crypto.ts`（`encrypt` / `decrypt`）
- `server/utils/serviceConnection.ts:upsertServiceConnection`
- `service_connections.access_token_encrypted` / `refresh_token_encrypted`

**変更影響**:

- アルゴリズム変更は **既存レコードの再暗号化** が必要。慎重に。
- `TOKEN_ENCRYPTION_KEY` を失うと復号できなくなるため、ローテーション運用は段階的に（旧鍵 → 新鍵を併存させ、復号は旧 → 新の順、暗号化は新で）。

---

## 401 リトライ

**関係箇所**:

- `server/utils/serviceConnection.ts:withFreshAccessToken`
- 各 `get<Provider>Data` が 401 を `OauthUnauthorizedError` で throw

**変更影響**:

- リトライ回数を増やしたい等は `withFreshAccessToken` 内のループ構造変更。
- Toggl のように refresh が無いサービスはそのまま投げ返す（変更時もこの境界に注意）。

---

## 同期ロック

**関係箇所**:

- `server/utils/syncLock.ts`（`tryAcquireSyncLock` / `markSyncSuccess` / `markSyncFailed`）
- `daily_sync_statuses` テーブル

**変更影響**:

- stale lock の判定（10 分）を変える → `STALE_LOCK_MINUTES`。Vercel Function の制限とのバランス。
- ownership キーを `sync_started_at` から別カラム（例: `lock_token uuid`）にする場合は migration + アプリ両方の変更。

---

## 部分失敗ハンドリング

**関係箇所**:

- `server/utils/runRefresh.ts:refreshUserDate`
- `summary.get.ts` のレスポンス `errors` フィールド
- `shared/schemas/errors.ts`

**変更影響**:

- エラーメッセージの整形（機密混入防止）を変える → `summarizeError`。

---

## 公開デモ

**関係箇所**:

- `app/pages/demo/index.vue` / `demo/daily/[date].vue`
- `server/api/demo/summary.get.ts`
- `demo_*` テーブル群
- `supabase/migrations/20260517160200_create_demo_tables.sql`
- `supabase/migrations/20260517160300_seed_demo_data.sql`

**依存**: 認証 / 外部 API には依存しない。

**変更影響**:

- デモデータを変える → migration（seed）を新規追加。
- 構造が本番テーブルとズレないよう注意。**完全分離が前提** なので、新規カラム追加時は demo にも追従するか判断が必要。

---

## require-connections ガード

**関係箇所**:

- `app/middleware/require-connections.ts`
- `server/api/internal/connections-required.get.ts`
- `shared/schemas/connections.ts:connectionsRequiredResponseSchema`

**変更影響**:

- 必須プロバイダを変える（Toggl も必須にする等）→ `server/api/internal/connections-required.get.ts` の判定ロジックと CLAUDE.md / SPEC 更新。

---

## エラートラッキング

**関係箇所**:

- `sentry.client.config.ts` / `sentry.server.config.ts`
- `nuxt.config.ts` の `sentry` セクション
- `SENTRY_AUTH_TOKEN`

**変更影響**:

- スコープ / sampling 変更は `sentry.*.config.ts`。
- リリース別追跡には source map upload が前提（`SENTRY_AUTH_TOKEN` 必須）。

---

## 機能を新規追加する時のテンプレ

```
1. SPEC.md / CLAUDE.md / 関連 Issue を読む
2. plan を立てる（どのテーブル / API / コンポーネントを触るか書き出す）
3. feature branch を切る
4. shared/schemas に I/O スキーマを追加（先に）
5. server/api or server/utils を実装（Zod 検証込み）
6. supabase/migrations を追加（必要なら）
7. app/pages or app/components を実装
8. pnpm typecheck / lint / lint:style
9. Playwright MCP で動作確認
10. PR を出す（Closes #<番号> + @codex review）
```

---

## 次に読むもの

- [architecture-overview.md](./architecture-overview.md) — 責務単位の分解
- [data-flow.md](./data-flow.md) — どの関数がどの関数を呼ぶか
