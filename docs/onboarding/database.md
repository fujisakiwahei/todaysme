# Database

このアプリのデータは **Supabase PostgreSQL** に格納する。テーブルは大きく 3 系統:

1. **アプリ固有のユーザープロファイル**（`public.users`）
2. **外部サービス連携 + 同期状態**（`service_connections` / `daily_sync_statuses`）
3. **同期されたデータ本体**（`oura_sleep_records` / `google_calendar_events` / `toggl_time_entries`）

加えて、公開デモ用の `demo_*` テーブル群が本番と完全分離して存在する。

> SQL の正は `supabase/migrations/` 配下。Supabase GUI で変更したら **必ず** マイグレーションファイルとしてコミットする（Issue #26）。

---

## ER 図

```mermaid
erDiagram
  users ||--o{ service_connections : has
  users ||--o{ daily_sync_statuses : has
  users ||--o{ oura_sleep_records : has
  users ||--o{ google_calendar_events : has
  users ||--o{ toggl_time_entries : has

  users {
    uuid id PK "auth.users.id と 1:1"
    text timezone "IANA, default Asia/Tokyo"
    text[] excluded_google_calendar_ids "(廃止予定: 行は残すが Phase 5 以降アプリは読み書きしない / Issue #131)"
    timestamptz created_at
  }

  service_connections {
    uuid id PK
    uuid user_id FK
    text provider "oura/google/toggl"
    text status "connected/disconnected/error/needs_reauth"
    text provider_user_id "Google は id_token.sub。複数アカウント連携の識別キー (Issue #131)"
    text account_email "Google のみ。settings 表示用 / 同名カレンダー衝突解決 (Issue #131)"
    text access_token_encrypted "JSON of {iv,authTag,ciphertext}"
    text refresh_token_encrypted
    timestamptz token_expires_at
    text scopes
    timestamptz connected_at "初回接続時刻 (refresh では上書きしない)"
    timestamptz updated_at
  }

  google_excluded_calendars {
    uuid user_id FK
    uuid connection_id FK "service_connections.id"
    text calendar_id PK "(connection_id, calendar_id) 主キー"
    timestamptz created_at
  }

  daily_sync_statuses {
    uuid id PK
    uuid user_id FK
    date target_date
    text source "oura/google/toggl"
    text status "idle/in_progress/success/failed"
    timestamptz sync_started_at "lockId としても使う"
    timestamptz last_synced_at
    text error_message
    timestamptz updated_at
  }

  oura_sleep_records {
    uuid id PK
    uuid user_id FK
    date target_date "= wake_at の日付 (ユーザータイムゾーン / Issue #24)"
    text oura_sleep_id "external id"
    timestamptz sleep_start_at
    timestamptz wake_at
    int sleep_minutes
    boolean is_deleted
  }

  google_calendar_events {
    uuid id PK
    uuid user_id FK
    uuid connection_id FK "service_connections.id (Issue #131 Phase 4 / ON DELETE CASCADE)"
    date target_date
    text google_event_id "calendar 内ユニーク"
    text calendar_id "(user_id, connection_id, calendar_id, google_event_id) で unique"
    text calendar_name
    text title
    timestamptz start_at
    timestamptz end_at
    boolean is_deleted
  }

  toggl_time_entries {
    uuid id PK
    uuid user_id FK
    date target_date
    text toggl_entry_id "external id"
    text title
    bigint project_id "Issue #112 / 未割当は NULL"
    text project_name "Issue #112 / 未解決は NULL"
    timestamptz start_at
    timestamptz end_at "進行中エントリは NULL"
    boolean is_deleted
  }
```

---

## 各テーブルの責務

### `public.users`

**役割**: Supabase Auth の `auth.users` に対応するアプリ固有のプロファイル。

- `id` は `auth.users.id` と 1:1（`on delete cascade`）。
- `auth.users` への INSERT を `public.handle_new_user()` トリガで捕捉して自動生成（`security definer`）。
- `timezone` … ユーザーの IANA タイムゾーン。`target_date` 算出 / wake range 計算で使う。
- `excluded_google_calendar_ids` …（**廃止予定 / Issue #131 Phase 5**）旧来の除外カレンダー保管先（配列）。Phase 5 で `google_excluded_calendars` テーブル（接続単位）に移行したため、**アプリ経路は読み書きしない**。ロールバック / 監査用に列だけ残してある。
- RLS: `select` / `update` を `auth.uid() = id` で自分自身に限定。

**なぜトリガで自動生成するのか**: ユーザーが初めて `/daily/today` を開いた時に「`public.users` 行が無くて 500 エラー」になるのを防ぐ。サインアップ時点で確実に行を作る。

### `service_connections`

**役割**: 外部サービストークン + 連携状態。

- **unique 制約は provider 別の partial unique index 2 本**（Issue #131 Phase 1b）:
  - Google: `(user_id, provider, provider_user_id) where provider='google'` — 同一ユーザーが複数 Google アカウント（= `provider_user_id` 別の複数行）を持てる。
  - Oura / Toggl: `(user_id, provider) where provider in ('oura','toggl')` — 1 ユーザー × 1 行に限定（旧仕様を維持）。
- `provider_user_id` …（**Issue #131 Phase 2**）Google は OAuth callback で取得した `id_token.sub` を JWKS 検証して入れる。アカウント識別の主キー。Oura / Toggl は使わない。
- `account_email` …（**Issue #131 Phase 2**）Google `id_token.email`。`/settings` で「どのアカウントか」を識別表示するため。集計時に同名カレンダーが衝突したら `"<name> (<email>)"` の接尾辞にも使う（Phase 7）。
- `status` … `connected` / `disconnected` / `error` / **`needs_reauth`**（Issue #131 Phase 2: `provider_user_id` 未取得の旧 Google 行に貼られる過渡状態。settings からの再認可で `connected` に戻る）。
- `access_token_encrypted` / `refresh_token_encrypted` は **AES-256-GCM** で暗号化した JSON 文字列（`{iv, authTag, ciphertext}`）。
- `connected_at` は **初回接続時刻** を保持。refresh のたびに上書きしてはいけない（`/api/connections` の「いつ繋いだか」表示が常に「今」になるため）。
- `updated_at` は **楽観ロック** にも使う（`markConnectionError` が「読み取り時点から行が動いていない」場合のみ status を error に落とす）。
- RLS は **`force row level security`** で **policy 0 個**。つまり authenticated client からは絶対に読めない。サーバが `getSupabaseAdmin()` で bypass する経路のみが読み出し手段。

**なぜ完全に隠すのか**: トークン暗号化は AES-256-GCM だが、`ciphertext` をブラウザに渡してしまうと「クライアントに鍵があれば復号できる」ことになり責務が崩れる。`has_token: boolean` のような派生情報だけ `/api/connections` 経由で返す。

**なぜ partial unique にしているのか**: Google は複数アカウント連携を許容する一方で、Oura / Toggl は MVP 単一行運用を維持したい。`(user_id, provider, provider_user_id)` の 3 列 unique では Oura / Toggl の `provider_user_id IS NULL` で NULL 重複が発生してしまうため、provider 別に index を分けて非対称な制約を表現している（設計: `docs/designs/multi-google-account.md` §4.1）。

### `daily_sync_statuses`

**役割**: (user × target_date × source) 単位の同期状態。**同期ロック** にも使う。

- `unique(user_id, target_date, source)` を排他のキーにする。
- `status`: `idle` / `in_progress` / `success` / `failed`。
- `sync_started_at` を **lockId** として使う:
  - `tryAcquireSyncLock` は奪取時に `sync_started_at = now()` を書く。
  - `markSyncSuccess` / `markSyncFailed` は **その値を WHERE 条件に含める** ことで「自分が握っている lock だけ更新」を保証。
- stale lock 回収: `sync_started_at` が **10 分** より古い `in_progress` は次の `tryAcquireSyncLock` で奪える。
- RLS: 4 ポリシー（`auth.uid() = user_id`）。

**なぜタイムスタンプではなく `unique` 制約 + 条件付き UPDATE なのか**: Postgres にロウレベルロックを直接張る代わりに、`unique` 制約 + 楽観ロック（`status != 'in_progress' OR sync_started_at < cutoff`）で「行を 1 件に絞り込み、原子的に状態遷移する」シンプルな構造にした。Vercel Functions のような短命プロセスから扱いやすい。

### `oura_sleep_records`

**役割**: Oura の睡眠記録。

- `unique(user_id, oura_sleep_id)` で external id を主キーとする upsert。
- `target_date` は **「ユーザータイムゾーンでの `wake_at` の日付」**（SPEC §2 / Issue #24）。睡眠開始日ではない。
- index: `(user_id, target_date)` と `(user_id, sleep_start_at, wake_at)` 両方。タイムライン取得時は range 検索を使う。
- RLS: 4 ポリシー。

**なぜ起床日に紐づけるのか**: ユーザーの体感としての「その日」は起床から始まる。深夜 0 時跨ぎで睡眠開始日と起床日が違う場合、起床日を target_date にすれば「自分の今日」と一致する。

### `google_calendar_events`

**役割**: Google Calendar のイベント。

- `unique(user_id, connection_id, calendar_id, google_event_id)` …（**Issue #131 Phase 4**）`connection_id` を含めることで、別アカウント（= 別接続）が同じ `calendar_id` / `event.id` を返してきても別行として扱える。
- `connection_id` … `service_connections.id` への FK（`ON DELETE CASCADE`）。同期経路はすべてこの列を埋め、ソフトデリート sweep / 除外設定の照合もこのキーでスコープする。
- `target_date` … ユーザータイムゾーンでのイベント日。タイムライン取得は wake range overlap で読む。
- `calendar_name` … `summaryOverride > summary` で決まる Google の表示名。
- index: `(user_id, target_date)` と `(user_id, start_at, end_at)` と `(user_id, connection_id, target_date)`。
- RLS: 4 ポリシー。

### `toggl_time_entries`

**役割**: Toggl Track の time entry。

- `unique(user_id, toggl_entry_id)`。
- `end_at` は **NULL を許容**（進行中エントリ）。read 側は `end_at IS NULL OR end_at >= fromIso` の or 条件で絞る。
- `project_id` / `project_name` …（**Issue #112**）Toggl の `/me/time_entries` には `project_id` しか載らないので、同期時に `/me/projects` で名前を解決して time entry 行に貼る。名前は Toggl 側で変わると次回 sync で上書きされる。未割当 / 未解決は NULL。
- RLS: 4 ポリシー。

### `google_excluded_calendars`

**役割**: 稼働時間集計から除外する Google カレンダーを **接続単位** で持つ（Issue #131 Phase 5）。

- 主キー: `(connection_id, calendar_id)`。同一接続内で同 `calendar_id` が重複しないことを保証。
- `connection_id` は `service_connections.id` への FK（`ON DELETE CASCADE`）。接続が物理削除されたら除外設定も巻き取って消える。
- `user_id` は RLS と user 単位の bulk read 用に冗長保持。
- RLS: 4 ポリシー（`auth.uid() = user_id`）。

**旧仕様との関係**: 旧来は `users.excluded_google_calendar_ids text[]` で持っていたが、複数 Google アカウント連携で「同じ calendar_id がアカウント間で別物を指す」可能性が出たため、`(connection_id, calendar_id)` で識別するテーブルへ移行した。旧列はロールバック / 監査用に残してあるが、アプリ経路は本テーブルだけを参照する。

### `free_time_notes`

**役割**: 終了済みの空き時間に、実際に何をしていたかを記録するユーザー入力データ。

- `unique(user_id, gap_start_at, gap_end_at)`で同一区間を1件に制限。
- `gap_start_at` / `gap_end_at`は保存時点のスナップショット。外部サービスの再同期では更新しない。
- `content`はtrim後1〜1,000文字。
- index: `(user_id, target_date, gap_start_at)`。
- RLS: 4ポリシー（`auth.uid() = user_id`）。

### `demo_*` テーブル群

**役割**: 公開デモ用データ。本番テーブルと完全分離。

- 認証不要 / 外部 API 不要。
- 公開 read 可能な RLS を設定。
- 本番テーブルに混ぜない理由: RLS / トークン / 同期状態の責務が崩れるため。

---

## RLS の実装パターン

全 user 紐づきテーブル（`service_connections` 除く）で同じパターン:

```sql
alter table public.<table> enable row level security;

create policy "<table>_select_own"
  on public.<table>
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "<table>_insert_own"
  on public.<table>
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "<table>_update_own"
  on public.<table>
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "<table>_delete_own"
  on public.<table>
  for delete
  to authenticated
  using (auth.uid() = user_id);
```

`service_connections` だけは:

```sql
alter table public.service_connections enable row level security;
alter table public.service_connections force row level security;
-- policy は貼らない
```

→ admin client（`SUPABASE_SECRET_KEY`）からしか読めない。

---

## ソフトデリート

```sql
update <table> set is_deleted = true where ...;
```

- 物理削除しない（SPEC §11.3）。
- 同期時に「外部側で消えたレコード」を `is_deleted = true` にする。
- read 側は **必ず** `eq("is_deleted", false)` で絞る。

理由:

- 外部 API 一時障害で「取れなかった = 削除された」と誤判定するのを防ぐ（厳密にはこちらは差分同期 + ソフトデリートで対応している）。
- 過去日の表示が空に化けるのを防ぐ。
- 必要なら admin が手動で復元できる。

---

## マイグレーション運用

1. **Supabase GUI で変更**（ローカル `supabase/` でも本番でも）。
2. 変更後の SQL を `supabase/migrations/<timestamp>_<description>.sql` としてコミット。
3. ファイル冒頭に **「何のための変更か」「背景となる Issue / SPEC §」** をコメントで書く（既存ファイルがこのスタイルなので合わせる）。
4. 既存のマイグレーションを編集しない（履歴を巻き戻すことになるため、新しいタイムスタンプの追加マイグレーションで対応）。

---

## なぜ `target_date` を持つのか

read 側は `start_at` / `end_at` の overlap で wake range と照合する設計だが、**`target_date` も持つ理由**:

1. **インデックスの効率**: `(user_id, target_date)` で素早く対象日付近のレコードを引ける。
2. **ソフトデリート時のスコープ絞り込み**: 「対象日に紐づく既存レコードのうち今回取得結果に含まれないもの」をソフトデリートする際に必要。
3. **Today's ME の oura 集計**: 「起床日 = `target_date` となる sleep」を選ぶ（SPEC §4.1）。

---

## 容量設計の考え方

MVP は単一ユーザー前提のため、大容量は想定していない:

- 14 日 × 1 ユーザー × 各サービス数十レコード程度。
- index は (user_id, target_date) と (user_id, start_at, end_at) の 2 種類。
- 将来マルチユーザー化する時は partition / archive を検討する。

---

## 変更時の注意点

- **新テーブルを追加する時の checklist**:
  - [ ] `user_id uuid not null references public.users (id) on delete cascade`
  - [ ] `is_deleted boolean not null default false`（同期データなら）
  - [ ] `created_at` / `updated_at` の `timestamptz default now()`
  - [ ] external id の `unique` 制約（同期データなら）
  - [ ] `(user_id, target_date)` index
  - [ ] **RLS を `enable`**
  - [ ] **select / insert / update / delete の 4 ポリシー**（`auth.uid() = user_id`）
  - [ ] マイグレーションファイル冒頭に責務コメント

- 既存テーブルにカラムを追加する時は、必ず新しいタイムスタンプのマイグレーションファイルで `alter table` を書く。

---

## 次に読むもの

- [auth.md](./auth.md) — RLS と認証の繋がり
- [external-services.md](./external-services.md) — どのデータをどう upsert するか
- [data-flow.md](./data-flow.md) — 読み取り / 書き込みのタイミング
