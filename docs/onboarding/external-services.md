# External Services

このアプリは **Oura / Google Calendar / Toggl Track** の 3 サービスを統合する。  
各サービスごとに「API 種類」「認証方式」「取得対象」「同期戦略」が違うため、責務分解を意識して読む。

---

## サービス一覧

| サービス            | API                                            | 認証                       | 取得対象                       | refresh の有無                       |
| ------------------- | ---------------------------------------------- | -------------------------- | ------------------------------ | ------------------------------------ |
| **Oura**            | API v2（`https://api.ouraring.com/v2`）        | OAuth2 / Bearer            | 睡眠 / 起床時刻 / readiness 等 | あり                                 |
| **Google Calendar** | API v3                                         | OAuth2 / Bearer            | 予定 + カレンダー一覧          | あり（refresh_token は初回認可だけ） |
| **Toggl Track**     | API v9（`https://api.track.toggl.com/api/v9`） | API token を Basic Auth で | 作業ログ                       | なし（個人用 MVP）                   |

各サービスの実装ファイル:

| 責務                   | Oura                               | Google                               | Toggl                                  |
| ---------------------- | ---------------------------------- | ------------------------------------ | -------------------------------------- |
| OAuth クライアント     | `server/utils/oauth/oura.ts`       | `server/utils/oauth/google.ts`       | （無し / API token）                   |
| API クライアント       | `server/utils/getOuraData.ts`      | `server/utils/getGoogleData.ts`      | `server/utils/getTogglData.ts`         |
| 同期 + upsert          | `server/utils/syncOura.ts`         | `server/utils/syncGoogle.ts`         | `server/utils/syncToggl.ts`            |
| Zod スキーマ           | `shared/schemas/oura.ts`           | `shared/schemas/google.ts`           | `shared/schemas/toggl.ts`              |
| OAuth start / callback | `server/api/connections/oura/*.ts` | `server/api/connections/google/*.ts` | `server/api/connections/toggl.post.ts` |

---

## 共通の責務階層

```
runRefresh.ts (オーケストレーション)
  └─ withFreshAccessToken (token 取得 + 401 retry)
      └─ get<Provider>Data (外部 API 呼び出し + Zod 検証)
          └─ fetch (HTTP)
sync<Provider>ForDate (upsert + ソフトデリート)
```

これは全サービスで共通。**どのサービスもこの 4 層に分けられている**。

---

## Oura

### スコープ

Oura API v2 の標準スコープ。Bearer トークンで API を叩く。Rate limit: 5000 req / 5 min。

### 取得対象

- **睡眠**（`/v2/usercollection/sleep`）… MVP は **睡眠時間にフォーカス**。
- 取得期間: `target_date ± 1 日` を `start_date` / `end_date` パラメータで投げる。

**なぜ ±1 日**:

- ユーザータイムゾーンと Oura 側の `day` がズレるケース。
- `wake_at` の補正で target_date が移動するケース。
- 取りこぼし防止のため広めに取る。upsert 時は `oura_sleep_id` で吸収できる。

### target_date の決め方

Oura の `day` をそのまま使わず、**`wake_at` をユーザータイムゾーンに変換した日付** を `target_date` にする（SPEC §2 / Issue #24）。

- `targetDateOf(wakeAt, timezone)` を server / app の両方に同じ実装で持つ。
- `Intl.DateTimeFormat("en-CA").format()` は ICU 依存で必ずしも ISO 形式を保証しないため、`formatToParts()` から `year` / `month` / `day` を取り出して自前で組み立てる（決定論性）。

### Refresh

`refreshOuraToken(refreshToken)` で access_token を再発行できる。`refresh_token` も新しく返ってくる場合があるため、`upsertServiceConnection` に渡して上書き保存する。

---

## Google Calendar

### スコープ

最小権限:

- `openid` … `id_token` を token endpoint レスポンスに含めるために必須。
- `email` … `id_token` に `email` / `email_verified` claim を入れるため。
- `https://www.googleapis.com/auth/calendar.events.readonly` … イベント取得
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly` … カレンダー一覧

**なぜ calendarList も**: SPEC §3 の分類ルールに必要な `calendar_name` を引くために `calendarList.list` が必要。`events.readonly` 単体では 403 になる。

**なぜ openid / email も**: 複数 Google アカウント連携を扱うために、callback で `id_token` を JWKS 検証して `sub`（= `provider_user_id`）と `email`（= `account_email`）を取り出して保存する必要があるため（Issue #131 Phase 2 / `server/utils/oauth/idTokenVerify.ts`）。

### 認可フロー

```
buildGoogleAuthorizeUrl(state, redirectUri)
  ↓ response_type=code, scope=..., state=<signed>, access_type=offline, prompt=consent
ユーザー認可
  ↓
exchangeGoogleCode(code, redirectUri)
  ↓
{ access_token, refresh_token, expires_in, scope, ... }
```

**`access_type=offline` + `prompt=consent`** は `refresh_token` を確実に得るための定型。

### redirect_uri の解決

`server/utils/oauth/redirectUri.ts` がリクエスト origin から組み立てる（Issue #100）。

**なぜ環境変数固定にしないのか**: Vercel Preview デプロイのドメインが毎回変わるため、固定だと Google Cloud Console 登録値とのズレで `redirect_uri_mismatch` が頻発する。Google Cloud Console に「localhost:3000」と「Preview URL のパターン」と「Production URL」を登録しておく運用。

### 取得

`getGoogleData({ token, timezone, timeMin, timeMax, syncTokens?, calendarIds? })`:

1. `calendarList.list` で対象カレンダー一覧を取得（呼び出し側が `calendarIds` で限定可能）。
2. 各カレンダーに対して `events.list` を pagination + 必要に応じて `syncToken` 差分同期。
3. 410 Gone が返ったら syncToken を破棄して `timeMin`/`timeMax` で全件再取得（`resyncedFromFullFetch = true`）。
4. レスポンスは `googleEventsListResponseSchema` で Zod 検証 → 502 ハンドリング。
5. `event.id` だけでなく **`calendar_id` も** 返す（カレンダー跨ぎの id 衝突対策）。

### upsert と削除戦略（最も複雑）

`syncGoogleForDate` は **接続単位** で呼ばれる（Issue #131 Phase 4）。`runRefresh.ts` で `listConnectedGoogleConnections(userId)` を回し、各 `connection_id` に対して以下を実行:

- `onConflict: user_id,connection_id,calendar_id,google_event_id` で upsert。`connection_id` を必ず埋める。
- 差分同期で `cancelled` イベント（`deletedEventIds`）は `connection_id` × `calendar_id` でスコープして `is_deleted = true` に。
- **`connection_id` × `calendar_id` ごとに** 「今回取得結果に含まれない既存行」をソフトデリート（`event_id` だけで判定すると別カレンダーの同名 id を、`connection_id` を省くと別アカウントのイベントを巻き込むため）。
- **`activeCalendarIds` に含まれない calendar_id の既存行** も対象日ぶんソフトデリート（購読解除されたカレンダーのイベント残骸を消す）。これも `connection_id` でスコープする。

### MVP の差分同期方針

- **syncToken は永続化しない**。毎回 `timeMin`/`timeMax` で全件再取得する。
- 将来的に DB に `syncTokens` を持って差分同期したい場合、`getGoogleData` の `syncTokens` 引数経由で渡せる構造になっている。

### Refresh

`refreshGoogleToken(refreshToken)` で access_token を再発行。

- **Google は通常 refresh レスポンスで `refresh_token` を返さない**。`upsertServiceConnection` に `undefined` で渡すと既存値を保持する（3 状態仕様）。

### Calendar 除外設定（Issue #108 → Issue #131 Phase 5）

**現行**: `google_excluded_calendars` テーブル（`(connection_id, calendar_id)` 主キー）に保存。複数 Google アカウント連携で「同じ calendar_id がアカウント間で別物を指す」可能性があるため、`connection_id` でスコープする。

- 除外イベントは Timeline には出すが（`is_excluded: true` でマーキング）、稼働時間集計から外す。
- `/settings` で接続カードごとのチェックボックス UI、`PUT /api/connections/google/excluded-calendars`（body に `connection_id` + `excluded_calendar_ids`）で保存。

**旧仕様**: `users.excluded_google_calendar_ids text[]` 配列（Issue #108 当時）。Phase 5 でテーブル化したが、列はロールバック用に残してある（アプリ経路は読み書きしない）。

---

## Toggl Track

### 認証

OAuth ではなく **API token を Basic Auth で**:

```
Authorization: Basic base64(<api_token>:api_token)
```

ユーザーが Toggl Profile 画面で発行した token をアプリ `/settings` に貼り付け、サーバが暗号化保存。

### 取得対象

- `/me/time_entries` … 作業ログ（time entry）。
- `/me/projects` … プロジェクト一覧。`project_id` → `project_name` の解決マップ（Issue #112）。
- 取得期間: `target_date ± 1 日` を `since` watermark で投げる。

### 同期

- `unique(user_id, toggl_entry_id)` で upsert。
- `end_at` が **NULL を許容**（進行中エントリ）。
- `project_id` / `project_name` を埋める。`/me/projects` で名前を解決した結果を time entry 行にデノーマライズして保存（Toggl 側でリネームされても次回 sync で上書き / 別テーブル化は MVP では避ける）。
- 対象日に紐づく既存行のうち取得結果に含まれないものはソフトデリート。

### Refresh の概念がない

API token は手動で再発行する仕様。`withFreshAccessToken` は Toggl では「401 が来たらそのまま再 throw する」だけ（refresh が無いので retry できない）。

---

## トークンの保管と取り出し

詳細は [auth.md](./auth.md) を参照。要点:

| 操作                     | どの関数                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| 暗号化保存               | `upsertServiceConnection({ accessToken, refreshToken?, ... })`                            |
| 通常の取得               | `withFreshAccessToken(provider, async (token) => fn(token))`                              |
| 期限近傍での自動 refresh | `getValidAccessToken` 内部で `performRefresh`                                             |
| 401 retry                | `withFreshAccessToken` が `OauthUnauthorizedError` をキャッチ → 強制 refresh → 1 回再試行 |
| 切断                     | `disconnectServiceConnection`（status を `disconnected` に / トークン null）              |

**`refresh_token` の 3 状態仕様**:

- `undefined` → 既存 DB 値を保持（Google の通常 refresh）。
- `null` → 明示的に null に。
- `string` → 新しい値で上書き。

---

## 外部 API のレスポンス検証

すべての外部 API クライアントは **`parseExternal`** を介して Zod 検証する:

```ts
const json = await res.json();
return parseExternal(googleTokenResponseSchema, json, "google");
```

- 失敗時 502 + `statusMessage: InvalidExternalResponse:google`。
- 「外部 API が仕様を変えた / 想定外のフォーマットを返した」を 502 で明示。500 ではない理由は、サーバ自身の問題ではないため。

---

## エラー時のフロー

```mermaid
flowchart TD
  call[withFreshAccessToken] --> get[get<Provider>Data]
  get --> fetch[fetch external API]
  fetch -->|200| schema[parseExternal: Zod 検証]
  schema -->|ok| ok[正常返却]
  schema -->|fail| ext502[502 InvalidExternalResponse]
  fetch -->|401| unauth[OauthUnauthorizedError throw]
  unauth --> retry[forceRefreshAccessToken]
  retry -->|ok| fetch2[fetch 再試行]
  retry -->|fail| refreshFail[OauthRefreshError / status=error]
  fetch -->|other 4xx/5xx| genericFail[Error]
  call --> sync[sync<Provider>ForDate]
  sync -->|DB error| dbFail[throw]
  call -->|all errors| runRefresh
  runRefresh --> markFailed[markSyncFailed + errors.push]
  runRefresh --> nextProvider[次のサービスへ続行 -- 部分失敗許容]
```

---

## レート制限の扱い

| サービス        | レート               | 現状の対応                               |
| --------------- | -------------------- | ---------------------------------------- |
| Oura            | 5000 req / 5 min     | MVP の単一ユーザー × 14 日では到達しない |
| Google Calendar | プロジェクトクオータ | 同上                                     |
| Toggl           | 公開仕様は緩い       | 同上                                     |

将来マルチユーザー化したら exponential backoff / queue を検討する。

---

## サービス追加時の checklist

新しい外部サービスを統合する場合:

- [ ] `server/utils/oauth/<provider>.ts` で authorize / token / refresh URL とクライアント関数を定義
- [ ] `server/utils/get<Provider>Data.ts` で API クライアント + Zod 検証
- [ ] `server/utils/sync<Provider>.ts` で upsert + ソフトデリート
- [ ] `shared/schemas/<provider>.ts` で API レスポンスと内部スキーマを定義（barrel から再 export）
- [ ] `service_connections.provider` の check 制約に追加（マイグレーション）
- [ ] `daily_sync_statuses.source` の check 制約に追加
- [ ] DB テーブルを作成（`user_id` FK / `is_deleted` / RLS）
- [ ] `runRefresh.ts` の `RUNNERS` / `ALL_PROVIDERS` に追加
- [ ] `server/api/connections/<provider>/start.get.ts` / `callback.get.ts` を作成
- [ ] `/settings` UI にカードを追加
- [ ] CLAUDE.md / SPEC.md / このオンボーディングを更新

---

## 次に読むもの

- [data-flow.md](./data-flow.md) — refresh の流れ
- [auth.md](./auth.md) — OAuth state / token の保管
- [database.md](./database.md) — テーブル構造
