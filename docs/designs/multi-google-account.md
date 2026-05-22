# 複数 Google アカウント連携 — 調査と設計ドラフト

- **対応 Issue**: [#109 Googleアカウントの複数連携](https://github.com/fujisakiwahei/todaysme/issues/109)
- **ステータス**: Draft / 調査段階（実装は別 Issue に分割）
- **位置付け**: `docs/SPEC.md` の補足。MVP 範囲外の長期施策（label: `long term`）。確定すれば SPEC §3 / §11.2 へ反映する。

このドキュメントは Issue #109 の本文「複数 Google アカウントでログイン可能かの調査から対応」を満たすための調査ノートと設計ドラフト。実装パッチは含まない。

---

## 1. 背景と現状

Today's ME は Oura / Google Calendar / Toggl Track を統合する個人ダッシュボードで、ユーザー（=開発者本人）が**個人用と仕事用など複数の Google アカウント**にカレンダーを分けて運用しているケースを想定する必要がある。現状は **1 ユーザーにつき 1 つの Google アカウントしか連携できない**（後述 §3 で詳細）。

Issue #109 の要求：
- 複数 Google アカウントのカレンダーを **同じタイムラインに統合表示**したい。
- まず「複数 Google アカウントで OAuth 連携を保持できるか」を調査するところから着手する。

---

## 2. Google 側の前提（OAuth 仕様の確認）

Google OAuth 2.0 の挙動を SPEC・実装と突き合わせて確認した結果：

| 項目 | 現状の前提 | 複数アカウント時の挙動 |
| --- | --- | --- |
| 認可エンドポイント | `https://accounts.google.com/o/oauth2/v2/auth`（`server/utils/oauth/google.ts`） | アカウント切替は `prompt=select_account` で Google 側ピッカーに任せられる。既に `prompt=consent` を渡している（refresh_token 取得目的）。`prompt=consent select_account` の併用は許可されている。 |
| `refresh_token` | アカウント＋クライアント＋スコープ単位で 1 本発行される。`access_type=offline` + `prompt=consent` で取得済み。 | 別アカウントで認可すれば **そのアカウント専用の refresh_token** が新規に発行される。既存アカウントの token に影響はしない。 |
| `provider_user_id` | 現状は **未取得 / 未保存**（`upsertServiceConnection` の `providerUserId` フィールドはあるが、Google callback では渡していない）。 | カレンダー識別の前段として、Google の安定 ID（`userinfo.sub` または `calendarList.list` の primary calendar id）を取得し、行の uniqueness 判定に使う必要がある。 |
| `calendarList.list` | 単一アカウント配下のカレンダーのみ返る。 | 別アカウントで `calendarList.list` を叩けば、そのアカウント配下のみが返る。**アカウント間でカレンダー id が衝突する保証はない**（実態は衝突しないが、それを前提にしてはいけない）。 |
| OAuth client / 認証情報 | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` 1 組。 | 同じ OAuth client で複数アカウント分の認可は完全に可能。クライアント側の追加準備は不要。 |
| Google Cloud Console 側のクォータ | `events.list` / `calendarList.list` の per-user / per-project クォータ。 | アカウントが増えた分だけ API 呼び出しが線形に増える。MVP の単一ユーザー運用なら問題にならない見込みだが、Cron 同期で複数アカウント × 14 日分を一気に叩く場合は要観察。 |

**結論**: Google 側は完全に対応可能。**詰めるべきは Today's ME 側のデータモデル・OAuth フロー・同期ロジック**。

---

## 3. 現状コードの「1 アカウント前提」の依存箇所

複数アカウント化で改修が必要な箇所を洗い出した。

### 3.1 DB スキーマ
- `supabase/migrations/20260517160100_create_production_tables.sql`
  - `service_connections` に `unique(user_id, provider)` 制約 → **1 ユーザー × 1 provider に行を 1 つしか持てない**。
  - `upsertServiceConnection` の `onConflict: "user_id,provider"`（`server/utils/serviceConnection.ts:130`）が同じ前提で動く。
- `google_calendar_events`
  - `unique(user_id, google_event_id)` → PR #59 直後の状態。
  - 既に Issue #39 のレビューで「event_id はカレンダー内でしかユニークではない」ことが認識され、後続の `20260521040000_add_calendar_id_to_google_events.sql` で `calendar_id` を追加し、unique は `(user_id, calendar_id, google_event_id)` ベースで運用されている（`server/utils/syncGoogle.ts:91`）。**マルチアカウントでも `calendar_id` 単体ではアカウント跨ぎで衝突しうる**ため、`(user_id, connection_id, calendar_id, google_event_id)` への拡張が必要。
- `users.excluded_google_calendar_ids text[]`（`20260522000000_add_excluded_google_calendar_ids.sql`）
  - 単一ユーザー × 単一接続前提で、配列で平らに持っている。
  - 複数アカウント化すると「どのカレンダーがどのアカウントのものか」が ID だけでは曖昧になりうる。アカウント跨ぎの calendar_id 衝突に備えて、**接続行に紐づける**か **`(connection_id, calendar_id)` のペアで持つ**形に変更する必要がある。
- `daily_sync_statuses`
  - `unique(user_id, target_date, source)` で `source` は `'oura' | 'google' | 'toggl'`。複数 Google アカウントで個別ステータスを管理したいかは要決定（§5 参照）。

### 3.2 OAuth フロー
- `server/api/connections/google/start.get.ts`
  - 認可開始時、固定 cookie 名 `todaysme_oauth_state_google` を使い、state は `createOauthState(userId)` で発行。
  - **同一ユーザーで 2 個目の Google アカウントを認可するときの判別ができない**（state が同じ cookie キーで上書きされる、認可後にどの「接続行」へ追記するか判断する手がかりが userId だけ）。
  - 追加アカウント連携用に
    - state の payload に `intent: "add" | "reauth" | "replace_for_connection_id"` を持たせる
    - or `prompt=select_account` を強制し、callback で `id_token.sub` を見て「既存の provider_user_id とマッチするか / 新規か」を判定する
    のどちらかが必要。

- `server/api/connections/google/callback.get.ts`
  - 現状は `upsertServiceConnection({ userId, provider: "google", ... })` を呼ぶだけ。**provider_user_id を取得していない**ので、複数アカウント対応の主キー候補が無い。
  - Google の token endpoint レスポンス（`shared/schemas/google.ts` の `googleTokenResponseSchema`）に `id_token` を含めるよう scope を拡張（`openid`）するか、`https://openidconnect.googleapis.com/v1/userinfo` を呼んで `sub` を取得する必要がある。

- `server/api/connections/[provider].delete.ts`
  - `disconnectServiceConnection(userId, provider)` で provider 単位の disconnect しかできない（`server/utils/serviceConnection.ts:155`）。複数アカウント化すると **接続行 id 単位の disconnect** が必要。

### 3.3 同期ロジック
- `server/utils/serviceConnection.ts`
  - `getValidAccessToken(userId, provider)` / `withFreshAccessToken(userId, provider, fn)` が「`(user_id, provider)` の単一行」前提で書かれている。複数アカウント化すると `connectionId` を引数に取る形に拡張する必要がある。
- `server/utils/syncGoogle.ts`
  - `withFreshAccessToken(userId, "google", ...)` を 1 回呼んで全カレンダーを取得 → upsert。複数アカウント化すると **各接続ごとに同じ流れを回す** ループが必要。
  - `softDeleteEventsForRemovedCalendars` は「対象ユーザー × 対象日で activeCalendarIds に含まれない既存イベントを削除」する実装（`server/utils/syncGoogle.ts:204-231`）。これを**接続単位**に絞らないと、アカウント A の同期が走るたびにアカウント B のイベントを誤削除する。
- `server/api/connections/google/calendars.get.ts`
  - `withFreshAccessToken(userId, "google", fetchCalendarList)` で**先頭の接続だけ**を返す形になる。複数アカウントの一覧を表示するには、各接続を順に叩いて結果をフラットに返す（接続 id でグルーピング）必要がある。
- `server/api/connections/google/excluded-calendars.put.ts`（読んでいないが） / `server/api/connections/index.get.ts`
  - `index.get.ts` は `provider` 単位で 3 行に集約している。複数アカウント化したら **`google` だけは N 件返る** 形に API を拡張する必要がある（or 別エンドポイント `/api/connections/google/accounts`）。

### 3.4 UI
- `app/pages/settings.vue`
  - `connections` 配列を `provider` で 1:1 に展開している（`provider === 'google'` で接続ボタンと除外設定 UI を出す）。複数アカウント化すると **「Google」ブロックがアカウント数ぶん**並ぶ形になる。
  - 「Google Calendar と接続する」ボタンが「**追加で**もう 1 つ接続する」へ役割が変わる。OAuth start のクエリに `intent=add` 等を渡す必要が出てくる。
  - 除外カレンダー UI は接続単位（= アカウント単位）にネストし直す。
- `app/components/DailySummaryView.vue`
  - 現状は「Google」レーンとして 1 本に統合されている。複数アカウントから来るイベントを **1 本に統合表示するのか / アカウント別に色分けするのか** はプロダクト判断が必要（§5）。
- 凡例・カレンダー別集計
  - `summary.google.by_calendar` 等の集計キーがアカウント跨ぎで衝突しないか要確認（calendar_id ベースなら基本問題ないが、同名カレンダー（"プライベート" 等）が複数アカウントに存在すると UI 上の見分けが難しい）。

---

## 4. 設計ドラフト

### 4.1 データモデル（提案）

```
service_connections (改修)
  id                       uuid PK
  user_id                  uuid FK
  provider                 text       -- 'oura' | 'google' | 'toggl'
  provider_user_id         text NULL  -- Google: id_token.sub (運用上 NOT NULL)。Oura/Toggl は当面 NULL のまま
  account_label            text NULL  -- ユーザーが付ける任意ラベル ("work", "personal" 等)
  account_email            text NULL  -- 表示用。userinfo.email から取得
  status / tokens / scopes / connected_at / updated_at  -- 既存
```

**unique 制約は「provider ごとに分けた部分インデックス」で表現する。**単一 unique で全 provider を縛ろうとすると、NULL 重複問題（PostgreSQL の合成 unique は NULL を distinct と見なす）が必ず発生し、`loadConnectionForToken(...).maybeSingle()` のような「provider 単位で 1 行」前提を壊してしまうため（Codex review #127 P1 — Oura / Toggl の `upsertServiceConnection` も `providerUserId` を渡さない作りなので、単純な 3 列 unique 化は不可）。

```sql
-- Google は (user, provider, sub) で 1 行（複数アカウントを許容）
create unique index service_connections_google_unique
  on service_connections (user_id, provider, provider_user_id)
  where provider = 'google';

-- Oura / Toggl は (user, provider) で 1 行のまま（単一接続を強制）
create unique index service_connections_single_provider_unique
  on service_connections (user_id, provider)
  where provider in ('oura', 'toggl');
```

ポイント：
- 既存の `unique(user_id, provider)` constraint は **drop**。代わりに上記 **partial unique index 2 本** に置き換える。
- Oura / Toggl は `provider_user_id` 不在のまま「1 ユーザー × 1 行」を物理的に強制できる（NULL 重複が起きない）。`loadConnectionForToken` の `.maybeSingle()` 前提が崩れない。
- Google は `provider_user_id IS NULL` の状態を許容するが、その NULL 状態でも複数行は作れない（後述の Phase 1a で「Google 行は最大 1 件」のレガシー前提を維持する別 partial index を併用する。§6 Phase 1a 参照）。
- 既存の Google 接続が backfill 前に 2 件以上できないよう、Phase 1a の `provider_user_id` NULL 期間は **`unique(user_id, provider)` を維持** することでさらに安全側に倒す。
- **アプリ側からは `ON CONFLICT` 推論に依存しない**（§4.2「callback での識別」末尾参照）。PostgREST/Supabase JS の `upsert({ onConflict: "cols" })` は partial index を推論できないので、`upsertServiceConnection` は explicit な「SELECT → UPDATE or INSERT」に切り替える。partial unique index は並行書き込み時の整合性ガードとしてだけ使う。
- `account_email` / `account_label` は表示用。ラベルが無ければ email、それも無ければ "Google (...sub末尾4桁)" 等にフォールバック。

```
google_calendar_events (改修)
  ...
  connection_id  uuid FK -> service_connections(id)  -- ★ 追加
  unique (user_id, connection_id, calendar_id, google_event_id)  -- ★ 改訂
```

ポイント：
- 既存 unique `(user_id, calendar_id, google_event_id)` を drop し、`connection_id` を含めた形で再定義。
- 既存行のマイグレーションは「現状の唯一の Google 接続行」へ全て紐付ければ済む（MVP は単一ユーザー / 単一アカウント運用なので破壊的でない）。

```
google_excluded_calendars (新規 / 既存 users 配列の置換)
  user_id        uuid FK
  connection_id  uuid FK -> service_connections(id) on delete cascade
  calendar_id    text
  primary key (connection_id, calendar_id)
```

`users.excluded_google_calendar_ids` を残したまま `connection_id` 別を新テーブルに切り出す。MVP 段階で配列 → テーブルへの一括 backfill は容易。

`daily_sync_statuses` は当面 `source='google'` を**アカウント横断で 1 件**のまま維持する案を提案する。アカウント別に分けると UI / cron / lock の判定が複雑になるわりに、ユーザーが「片方失敗・片方成功」を見たいニーズが明確でないため。アカウント別の細粒度は `error_message` に JSON で乗せる方向で十分。

### 4.2 OAuth フロー

1. **追加接続フロー**
   - settings の Google セクションに「別のアカウントを追加」ボタン。
   - `GET /api/connections/google/start?intent=add` を叩く。
   - state payload に `intent: "add"` を含める（あるいは cookie 名を `todaysme_oauth_state_google_add` に分離して並行フローを許容）。
   - 認可 URL には `prompt=consent select_account` を渡し、Google 側で別アカウントを選ばせる。
2. **callback での識別**
   - scope に `openid email` を追加 → token endpoint レスポンスに含まれる `id_token` を **必ず検証してから** `sub` / `email` を取り出す。検証項目：
     - 署名（Google の JWKS `https://www.googleapis.com/oauth2/v3/certs` で検証。RS256）
     - `iss` が `https://accounts.google.com` または `accounts.google.com`
     - `aud` が `GOOGLE_CLIENT_ID` と一致
     - `exp` が現在時刻より未来 / `iat` の clock skew を 5 分以内で許容
     - `nonce` を渡している場合は state 側に保持した nonce と一致（CSRF 二重防御。MVP では state cookie で代替してもよいが、検証ロジック自体は実装しておく）
   - JWKS は短期キャッシュ（5–15 分）して連続呼び出しを避ける。`jose` 等のライブラリを使う想定。
   - **token endpoint は HTTPS 直通だが、`id_token` の中身は OAuth 仕様上「クライアントが検証する責務」を持つ**。Codex review #127 で「未検証 claim を `provider_user_id` に使うと、トークンが malformed / 想定外の発行元を指していた場合にアカウント mis-link 〜 不正な行紐付けに繋がる」と指摘済み（P1）。
   - 検証後、既存 `service_connections` に `(user_id, provider='google', provider_user_id=sub)` の行があれば update（**=「再認可」**として扱う）、無ければ insert（**=「新規アカウント追加」**）。
   - **`upsertServiceConnection` は `upsert(..., { onConflict })` をやめ、explicit な「SELECT → UPDATE or INSERT」に切り替える**（Codex review #127 追加 P1）。
     - 理由: Supabase JS / PostgREST の `onConflict` パラメータは **カラム列名のみ** を受け取り、生成される SQL は `ON CONFLICT (cols)` だけ。PostgreSQL の `ON CONFLICT` 推論が partial unique index にマッチするには **`ON CONFLICT (cols) WHERE <predicate>` のように predicate を併記** する必要があり、partial index には PostgREST 経由で到達できない → Phase 1b で旧 `unique(user_id, provider)` を drop した瞬間に `42P10 (no unique or exclusion constraint matching the ON CONFLICT specification)` で全 upsert が失敗する。
     - 既存実装でも `upsertServiceConnection` は最初に `select(...).eq("user_id", ...).eq("provider", ...).maybeSingle()` で既存行を読んでいる（`server/utils/serviceConnection.ts:71-76`）。この select を **「Google は `(user_id, provider, provider_user_id)` で 1 行特定」「Oura / Toggl は `(user_id, provider)` で 1 行特定」** に分岐させ、ヒットすれば `update().eq(...)`、無ければ `insert(...)` を呼ぶ。
     - partial unique index は **write 時の整合性ガード**（並行 INSERT の二重行を物理的に防ぐ）として残す。アプリ側はそれを `ON CONFLICT` 推論には使わず、explicit な存在チェック + UPDATE/INSERT 経路で運用する。
     - `performRefresh` 等の経路も同じ関数を通るので、リファクタは `upsertServiceConnection` 1 関数の差し替えで済む。`getValidAccessToken` / `loadConnectionForToken` 側のクエリも Google だけは `provider_user_id` を引数に取れるよう（`(userId, "google", providerUserId)`）拡張する必要がある（Phase 4 同期ループから渡される）。
     - 補足: 代替案として「Postgres 側で RPC（`security definer` の関数）を作り、`ON CONFLICT (..., provider_user_id) WHERE provider = 'google'` を生 SQL で書く」もあるが、関数の維持コスト・RLS との相性を踏まえると explicit select / update / insert のほうがシンプル。
3. **既存 1 接続のマイグレーション（必須 backfill）**
   - **重要**: PostgreSQL の unique constraint / unique index は **NULL を distinct と見なす**ため、`unique(user_id, provider, provider_user_id)` を張った状態で既存行の `provider_user_id` を NULL のまま放置すると、**「NULL 持ちレガシー行」と「sub を持つ新規行」が同じ user / 同じ provider で共存できてしまう**（= 同期処理が両方の行に対して走り、Google Calendar イベントが重複 / 整合性破壊）。Codex review #127 で P1 指摘あり。
   - 採用案: **Phase 分割 + provider 別 partial unique index** の組み合わせ（§4.1 参照）。
     - Phase 1a: `provider_user_id` カラムを追加（NULL 許容のまま）／`unique(user_id, provider)` は **維持**。既存の Oura/Google/Toggl 行は全てこの制約下で動き続ける。
     - Phase 1a': さらに念のため `create unique index ... on service_connections (user_id, provider) where provider = 'google' and provider_user_id is null;` の **過渡期用 partial index** を張り、「sub 未取得の Google 行」が複数できないよう保険をかける（再認可フローと並行運用するため）。
     - Phase 2: 既存 Google 行を `status = 'needs_reauth'` に落とし、settings に再認可バナー → ユーザーが再認可 → callback で `id_token` 検証 → `provider_user_id = sub` を埋める。
     - Phase 1b: 「`provider_user_id IS NULL AND provider = 'google'` な行が 0 件」を移行スクリプトで検査確認したうえで、以下を 1 トランザクションで実行：
       1. 既存の `unique(user_id, provider)` constraint を drop。
       2. Phase 1a' で張った過渡期用 partial index を drop。
       3. §4.1 の 2 本（Google 用 `where provider = 'google'` / Oura・Toggl 用 `where provider in ('oura','toggl')`）を新たに張る。
     - **Phase 1b 完了までは「アカウント追加」UI は無効化**。
   - 検査スクリプト例:
     ```sql
     select count(*) as legacy_null_rows
     from service_connections
     where provider = 'google' and provider_user_id is null;
     -- = 0 であることを確認してから unique 張替を行う。
     ```
   - 個人運用とはいえ、Phase 2（OAuth callback）と Phase 3（アカウント追加 UI）の間に **必ず backfill 完了の検査ステップ** を挟む。
4. **切断フロー**
   - `DELETE /api/connections/google/:connectionId` 形式へ拡張する（or クエリで `?connection_id=...`）。`[provider].delete.ts` の API 形を変える必要があるため、Oura / Toggl も含めた API 互換性は別途検討。

### 4.3 同期ロジックの拡張

- `withFreshAccessToken` を `(userId, connectionId, provider, fn)` の形に拡張、もしくは「`connection_id` を引数に取る低レベル版」を追加して既存 API は後方互換ラッパで残す。
- `syncGoogleForDate(userId, targetDate, timezone)` は以下のループ形に変更：
  ```ts
  const googleConnections = await listGoogleConnections(userId);
  for (const conn of googleConnections) {
    await withFreshAccessTokenById(conn.id, "google", (token) =>
      syncOneConnectionForDate(conn, targetDate, timezone, token),
    );
  }
  ```
- `softDeleteEventsForRemovedCalendars` は **接続スコープ内** で動かす（クエリに `connection_id = $conn` を足す）。
- 401 / refresh の動作は接続単位で独立。片方が `OauthRefreshError` で `status='error'` に落ちても、もう片方は通常通り動く（`daily_sync_statuses.error_message` には service ごとの部分失敗が乗る — SPEC §9.2）。

### 4.4 UI

- 設定画面：Google セクションを「アカウントリスト」化。
  - 各アカウント行に「再認可」「ラベル編集」「除外カレンダー設定」「切断」
  - 一番下に「別のアカウントを追加」ボタン
- ダッシュボード（DailySummaryView）：
  - 当面は **calendar_id ベースの分類はそのまま**、UI 上はアカウントを意識せず 1 本のレーンに統合表示する案を推す（複雑度を上げない）。
  - 同名カレンダーが衝突した場合の表示名は `"<calendar_name>（<account_label or email>）"` のように接尾辞を付けるフォールバックを入れる。
- 接続数の上限：MVP では特に上限を設けない（実運用では 2–3 アカウント想定）。

### 4.5 セキュリティ / RLS

- `service_connections` の RLS ポリシーは現状 `auth.uid() = user_id` ベース。複数アカウント化後も同じで OK（行が増えるだけ）。
- `google_calendar_events` も同様。`connection_id` が増えるが RLS は user_id ベースのまま十分。
- トークン暗号化（AES-256-GCM）は接続行単位で独立に持つので、現状の暗号化処理（`server/utils/crypto.ts` + `serviceConnection.ts`）はそのまま。

---

## 5. 未決事項 / 要相談ポイント

設計に進む前にユーザーへの確認が要るもの：

1. **タイムライン上で「アカウント」を識別するか**
   - 推奨: しない（calendar_id × calendar_name で識別する従来モデル）。
   - 代替: アカウント別の色帯 / ラベルを付ける。
2. **アカウントごとのラベル UI を出すか**
   - 推奨: email を自動表示 + 任意の `account_label` 入力欄を後出しで追加。
3. **再認可フローのリダイレクト先**
   - 現状 `/settings?connected=google` 固定。アカウント追加時は `/settings?connected=google&account=<email>` のように識別子を返してハイライトしたい。
4. **切断 API のシェイプ変更**
   - `/api/connections/google` を `/api/connections/google/:connectionId` 化するか、`?connection_id=` クエリで凌ぐか。
5. **マイグレーション順序**
   - §4.1 / §4.2 のとおり、**unique 制約は provider 別の partial unique index に置き換える**（Google のみ 3 列 / Oura・Toggl は従来の 2 列）、**かつ張り替えは backfill 完了後**。順序は: ①`provider_user_id` カラム追加（NULL 許容、既存 `unique(user_id, provider)` 維持、過渡期用 partial index も追加）→ ②再認可で Google 行の `sub` 埋め → ③ NULL 残存ゼロを SQL 検査 → ④ 旧 `unique(user_id, provider)` と過渡期 index を drop → §4.1 の 2 本の partial unique index を新規作成 → ⑤「アカウント追加」UI 有効化。Vercel preview で段階的に検証する。
6. **デモデータへの波及**
   - `demo_*` テーブル / `demo/summary` は今回触らない方針で良いか（デモはあくまで「1 アカウント分のショーケース」）。

---

## 6. 段階的実装プラン（フォロー Issue 候補）

| 段階 | 概要 | 主な変更先 |
| --- | --- | --- |
| Phase 0（本 PR） | この設計ドラフト Doc | `docs/designs/multi-google-account.md` |
| Phase 1a | DB マイグレーション 第1段: `service_connections` に `provider_user_id` カラム追加（NULL 許容）。`unique(user_id, provider)` は **そのまま維持**し、追加で「Google かつ provider_user_id IS NULL の行は 1 件まで」の過渡期用 partial unique index を張る（再認可フローと並行運用するための保険）。 | `supabase/migrations/` |
| Phase 2 | OAuth callback で `id_token` を **JWKS で検証**（iss / aud / exp / 署名）した上で `sub` / `email` を取り、`provider_user_id` を埋める。`shared/schemas/google.ts` に `id_token` を含むトークンレスポンス検証を追加。Google 接続行に `status='needs_reauth'` のセマンティクスを追加し、settings に再認可バナーを出す。 | `oauth/google.ts`, `connections/google/callback.get.ts`, `shared/schemas/google.ts`, `serviceConnection.ts`, `app/pages/settings.vue` |
| Phase 1b | Backfill 完了の検査スクリプト（`provider_user_id IS NULL AND provider='google'` が 0 件）を回したうえで、1 トランザクションで: ①旧 `unique(user_id, provider)` constraint を drop ②過渡期用 partial index を drop ③§4.1 の 2 本の partial unique index（Google = 3 列 / Oura・Toggl = 2 列）を作成 ④**`upsertServiceConnection` を `upsert({ onConflict })` から explicit な「SELECT → UPDATE or INSERT」に書き換え**（PostgREST の `onConflict` は partial index に推論マッチせず `42P10` で落ちるため。§4.2 末尾参照）。**ここを通過するまで「アカウント追加」UI は出さない**。 | `supabase/migrations/`, `serviceConnection.ts` |
| Phase 3 | settings UI に「別のアカウントを追加」導線 / `intent=add` フローと `prompt=select_account` 対応 | `app/pages/settings.vue`, `connections/google/start.get.ts` |
| Phase 4 | `google_calendar_events.connection_id` 追加 / sync ロジックを接続単位ループに変更 / `softDeleteEventsForRemovedCalendars` の絞り込み | `supabase/migrations/`, `syncGoogle.ts`, `getGoogleData.ts` |
| Phase 5 | 除外カレンダー設定を `google_excluded_calendars` テーブルへ移行（接続単位） | `supabase/migrations/`, `connections/google/calendars.get.ts`, `excluded-calendars.put.ts`, `settings.vue` |
| Phase 6 | 切断 API を接続 id 単位へ拡張 / 接続ラベル編集 UI | `connections/[provider].delete.ts` 周辺, `settings.vue` |
| Phase 7 | ダッシュボード表示の最終調整（同名カレンダー衝突時のラベル付け、必要なら凡例） | `DailySummaryView.vue`, `summary.get.ts` |

各 Phase は単独 PR で out / merge できる粒度を意識している。Phase 4 が一番重いので、ここを単独でレビューに集中させる想定。

---

## 7. 参考

- 現在の Google 連携実装
  - `server/utils/oauth/google.ts`（authorize / token / refresh）
  - `server/utils/serviceConnection.ts`（暗号化保存・refresh ラッパ）
  - `server/utils/syncGoogle.ts` / `server/utils/getGoogleData.ts`（同期処理）
  - `server/api/connections/google/*`（OAuth エンドポイントと calendarList）
  - `app/pages/settings.vue`（設定 UI）
- 関連 SPEC: `docs/SPEC.md` §3 / §6 / §11.2 / §12.1
- 関連 Issue: #52（Google OAuth 初期実装）/ #75（refresh 戦略）/ #108（除外カレンダー）/ #122（settings リンク追加）
