-- =============================================================================
-- 本番テーブル一式
-- =============================================================================
--
-- 【ファイル全体の構成】
--   1. service_connections      ... 外部サービス連携 (Oura / Google / Toggl) の
--                                   トークンとメタ情報
--   2. daily_sync_statuses      ... 「ユーザー × 対象日 × サービス」単位の同期
--                                   ステータス。多重実行ロックも兼ねる
--   3. oura_sleep_records       ... Oura の睡眠データ (起床日基準)
--   4. google_calendar_events   ... Google Calendar の予定
--   5. toggl_time_entries       ... Toggl Track の作業ログ
--
-- 【共通用語】
-- - `target_date`     ... そのレコードが「どの日のデータか」を表す date 型。
--                         Oura 睡眠は起床日基準 (Issue #24): 睡眠開始ではなく
--                         wake_at の日付 (ユーザータイムゾーン) を採用する。
--                         例: 2026-05-15 23:30 から眠り 2026-05-16 07:00 起床
--                         なら target_date = 2026-05-16。
-- - Wake-based         ... 「1 日」を 00:00–24:00 ではなく「前回起床〜次回睡眠
--   Timeline             (または現在)」として扱う表示モデル。Calendar/Toggl の
--                         表示判定は target_date 完全一致ではなく、wake range
--                         と (start_at, end_at) の重なりで行う必要がある。
-- - ソフトデリート     ... `is_deleted = true` で論理削除する運用。同期時に
--                         外部 API から取得できなくなったレコードは物理削除
--                         せず is_deleted を立てる (仕様 §11.3)。
-- - 外部 ID            ... oura_sleep_id / google_event_id / toggl_entry_id の
--                         こと。外部サービス側で一意な ID で、upsert キーに
--                         使うことで再同期しても重複しない。
--
-- 【RLS の方針】
-- - 全テーブルで RLS 有効化
-- - 各ユーザー紐づきテーブルは `auth.uid() = user_id` で行を絞る
-- - 例外: service_connections は暗号化トークン列を含むため、authenticated には
--   一切ポリシーを与えず Nuxt server API (service_role) からのみ操作させる
--   (仕様 §12.1 / Codex レビュー指摘)
-- =============================================================================


-- =============================================================================
-- 1. service_connections
-- =============================================================================
-- 外部サービスとの OAuth/API 連携状態を保持するテーブル。
--
-- 【役割】
-- - 連携サービスごとに 1 行 (unique(user_id, provider))
-- - access_token / refresh_token を AES-256-GCM で暗号化して保存
-- - 表示状態 (connected / disconnected / error)、token 有効期限、スコープ等を持つ
--
-- 【暗号化方針 (仕様 §12.1)】
-- - 暗号鍵 (TOKEN_ENCRYPTION_KEY) は Vercel env に置く。DB には絶対に置かない
-- - DB に格納するのは `iv`・`authTag`・`ciphertext` を含む blob (実体はテキスト
--   としてシリアライズしたものを 1 カラムに収める。シリアライズ形式は Issue
--   #51 のトークン暗号化ユーティリティ実装に従う)
-- - 平文トークンはサーバ内メモリでのみ復号する。ブラウザに返さない・ログに
--   出さない
--
-- 【provider に取り得る値】
-- - 'oura'   ... Oura Ring (OAuth2)
-- - 'google' ... Google Calendar (OAuth2)
-- - 'toggl'  ... Toggl Track (API token)。MVP では個人 API token を流用
-- =============================================================================
create table public.service_connections (
  id uuid primary key default gen_random_uuid(),

  -- どのユーザーの連携かを示す FK。ユーザー削除に追従する。
  user_id uuid not null references public.users (id) on delete cascade,

  -- 連携サービス名。CHECK 制約で値域を制限。
  provider text not null,

  -- 連携の状態。token リフレッシュ失敗時などに 'error' に落とす想定。
  status text not null default 'connected',

  -- 外部サービス側のユーザー識別子 (Oura の user id 等)。表示・突き合わせ用。
  provider_user_id text,

  -- AES-256-GCM 暗号化済みトークン。iv/authTag/ciphertext を含む blob。
  access_token_encrypted text,
  refresh_token_encrypted text,

  -- access_token の期限。期限切れなら refresh_token でサーバ側更新する。
  token_expires_at timestamptz,

  -- OAuth の付与スコープ (space または comma 区切り)。診断用。
  scopes text,

  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint service_connections_provider_check
    check (provider in ('oura', 'google', 'toggl')),
  constraint service_connections_status_check
    check (status in ('connected', 'disconnected', 'error')),

  -- 同じユーザーは同じ provider に対して 1 連携のみ。再連携時は UPDATE で上書き。
  constraint service_connections_user_provider_unique
    unique (user_id, provider)
);

create index service_connections_user_id_idx on public.service_connections (user_id);

comment on table public.service_connections is
  '外部サービス連携 (Oura / Google / Toggl) のトークンとメタ情報。'
  'access/refresh トークンは AES-256-GCM 暗号化済みの blob として格納し、'
  'クライアントに返してはならない (仕様 §12.1)。';
comment on column public.service_connections.provider is
  '連携サービス名。oura / google / toggl のいずれか。';
comment on column public.service_connections.status is
  '連携状態。connected / disconnected / error。トークンリフレッシュに失敗した'
  '場合は error に落とし、設定画面で再連携を促す。';
comment on column public.service_connections.access_token_encrypted is
  'AES-256-GCM で暗号化した access token (iv / authTag / ciphertext を含む blob)。'
  'クライアントへ返してはならない。';
comment on column public.service_connections.refresh_token_encrypted is
  'AES-256-GCM で暗号化した refresh token (iv / authTag / ciphertext を含む blob)。'
  'クライアントへ返してはならない。';
comment on column public.service_connections.token_expires_at is
  'access_token の有効期限。期限切れなら refresh_token でサーバ側更新する。';

-- RLS: 暗号化トークンを含むため、authenticated / anon には一切ポリシーを
-- 与えない。RLS 有効 + ポリシー不在で全アクセス拒否となり、service_role
-- (Nuxt server API) からのみ操作可能になる。force row level security により
-- テーブル所有者であっても RLS を逃れられないようにする。仕様 §12.1。
alter table public.service_connections enable row level security;
alter table public.service_connections force row level security;


-- =============================================================================
-- 2. daily_sync_statuses
-- =============================================================================
-- 「ユーザー × 対象日 × サービス」単位での同期ステータスを管理するテーブル。
--
-- 【役割】
-- - 表示時にステイル判定 (当日かつ last_synced_at が 30 分以上前) に使う
-- - 同期処理 (POST /api/summary/refresh) の多重実行ロックを兼ねる
-- - 部分失敗を許容する設計 (仕様 §9.2): サービス単位で success / failed を記録
--
-- 【多重実行ロックの考え方】
-- 同じ (user_id, target_date, source) で `status = 'in_progress'` の行が
-- すでにあれば「他のプロセスが同期中」と判断して二重実行を回避する。
-- unique 制約はこのロックキーそのもの。
--
-- 【status 遷移】
--   idle ──(refresh 開始)──▶ in_progress
--   in_progress ──(成功)──▶ success
--   in_progress ──(失敗)──▶ failed
--   failed / success ──(次回の refresh 開始)──▶ in_progress
--
-- sync_started_at が古すぎる in_progress は「タイムアウト」とみなして
-- 上書き可能にすると堅牢。
-- =============================================================================
create table public.daily_sync_statuses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,

  -- 同期対象の日 (ユーザータイムゾーン基準)。
  target_date date not null,

  -- 同期対象サービス。oura / google / toggl のいずれか。
  source text not null,

  -- 同期ステータス。
  status text not null default 'idle',

  -- 直近で in_progress に遷移した時刻。タイムアウト判定に使う。
  sync_started_at timestamptz,

  -- 直近で success/failed に遷移した時刻。ステイル判定 (30 分閾値) に使う。
  last_synced_at timestamptz,

  -- 失敗時のエラーメッセージ。表示・調査用。
  error_message text,

  updated_at timestamptz not null default now(),

  constraint daily_sync_statuses_source_check
    check (source in ('oura', 'google', 'toggl')),
  constraint daily_sync_statuses_status_check
    check (status in ('idle', 'in_progress', 'success', 'failed')),

  -- (user_id, target_date, source) でロックキーとして機能させる。
  constraint daily_sync_statuses_user_date_source_unique
    unique (user_id, target_date, source)
);

-- 当日表示時 (target_date = today) の絞り込みを高速化する複合インデックス。
create index daily_sync_statuses_user_date_idx
  on public.daily_sync_statuses (user_id, target_date);

comment on table public.daily_sync_statuses is
  'ユーザー × 対象日 × サービス単位の同期ステータス。表示時のステイル判定と、'
  'refresh 実行時の多重実行ロックを兼ねる (unique 制約がロックキー)。';
comment on column public.daily_sync_statuses.status is
  'idle / in_progress / success / failed。in_progress が排他ロックの役割を持つ。';
comment on column public.daily_sync_statuses.sync_started_at is
  'in_progress 遷移時の時刻。古すぎる in_progress はタイムアウトとして'
  '上書き可能にする想定。';
comment on column public.daily_sync_statuses.last_synced_at is
  '最後に同期が完了した時刻。当日かつ 30 分以上経過していたら裏で refresh する'
  '(仕様 §10.2)。';

alter table public.daily_sync_statuses enable row level security;

create policy "daily_sync_statuses_select_own"
  on public.daily_sync_statuses
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "daily_sync_statuses_insert_own"
  on public.daily_sync_statuses
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "daily_sync_statuses_update_own"
  on public.daily_sync_statuses
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "daily_sync_statuses_delete_own"
  on public.daily_sync_statuses
  for delete
  to authenticated
  using (auth.uid() = user_id);


-- =============================================================================
-- 3. oura_sleep_records
-- =============================================================================
-- Oura Ring の睡眠データを保持するテーブル。
--
-- 【target_date の決め方 (Issue #24)】
-- ユーザーの感覚では「2026-05-16 の睡眠」と言うとき、それは「2026-05-16 の朝
-- 起きるまで眠っていた睡眠」を指す。よって target_date は wake_at の日付
-- (ユーザータイムゾーン上) とする。
-- 例:
--   sleep_start_at = 2026-05-15 23:30 (Asia/Tokyo)
--   wake_at        = 2026-05-16 07:00 (Asia/Tokyo)
--   → target_date  = 2026-05-16
--
-- 【表示時の読み方】
-- Oura はその日 1 件想定でも、Wake-based Timeline に乗せる際は wake range と
-- 重なりが必要になるため、target_date 一致だけでなく
-- (sleep_start_at, wake_at) の範囲インデックスでも引けるようにしておく。
--
-- 【冪等な upsert】
-- 外部 ID `oura_sleep_id` を unique キーにすることで、再同期しても重複行が
-- 生まれない (ON CONFLICT (user_id, oura_sleep_id) DO UPDATE)。
-- =============================================================================
create table public.oura_sleep_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,

  -- 起床日 (Issue #24): wake_at の日付をユーザータイムゾーンで切ったもの。
  target_date date not null,

  -- Oura API の睡眠レコード ID。upsert の冪等キー。
  oura_sleep_id text not null,

  sleep_start_at timestamptz not null,
  wake_at timestamptz not null,

  -- 睡眠時間 (分)。スコア等の指標は将来 daily_* 系テーブルを別途追加する想定。
  sleep_minutes integer,

  -- 同期で取得できなくなった場合に true (物理削除しない / 仕様 §11.3)。
  is_deleted boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint oura_sleep_records_user_sleep_unique
    unique (user_id, oura_sleep_id)
);

-- target_date 一致での取得高速化用。
create index oura_sleep_records_user_target_date_idx
  on public.oura_sleep_records (user_id, target_date);
-- Wake-based Timeline 用の重なり判定 (sleep_start_at, wake_at) を高速化。
create index oura_sleep_records_user_range_idx
  on public.oura_sleep_records (user_id, sleep_start_at, wake_at);

comment on table public.oura_sleep_records is
  'Oura Ring の睡眠ログ。target_date は起床日 (Issue #24) で、wake_at の'
  'ユーザータイムゾーン上の日付。同期で取得できなくなったレコードは'
  'is_deleted=true でソフトデリート (仕様 §11.3)。';
comment on column public.oura_sleep_records.target_date is
  'ユーザータイムゾーンにおける wake_at の日付 (Issue #24)。'
  '睡眠開始日ではない点に注意。';
comment on column public.oura_sleep_records.oura_sleep_id is
  'Oura API 上の睡眠レコード ID。(user_id, oura_sleep_id) を upsert の冪等キーに使う。';
comment on column public.oura_sleep_records.is_deleted is
  'ソフトデリートフラグ。同期で取得できなくなった既存レコードに立てる。';

alter table public.oura_sleep_records enable row level security;

create policy "oura_sleep_records_select_own"
  on public.oura_sleep_records
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "oura_sleep_records_insert_own"
  on public.oura_sleep_records
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "oura_sleep_records_update_own"
  on public.oura_sleep_records
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "oura_sleep_records_delete_own"
  on public.oura_sleep_records
  for delete
  to authenticated
  using (auth.uid() = user_id);


-- =============================================================================
-- 4. google_calendar_events
-- =============================================================================
-- Google Calendar の予定 (events) を保持するテーブル。
--
-- 【カレンダー単位での分類 (仕様 §3 分類ルール)】
-- 個々の予定は所属カレンダー名 (例: パーソナル / MTG / 学習 / 予定ブロック) で
-- 分類する。色や種別での分類はしない。calendar_name にカレンダー名を保存する。
--
-- 【表示時の読み方 (重要)】
-- target_date 完全一致ではなく、wake range (前回起床〜次回睡眠) と
-- (start_at, end_at) の重なりで読む。深夜またぎ予定の取りこぼし防止のため。
-- 例: 23:50–00:30 の予定は target_date がどちらでも片方の wake range に含まれる。
--
-- 【冪等な upsert】
-- 外部 ID `google_event_id` を unique キーにする。
-- =============================================================================
create table public.google_calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,

  -- 補助インデックス用。基本は start_at のユーザータイムゾーン上の日付。
  -- 表示判定の主役は (start_at, end_at) の重なり。
  target_date date not null,

  -- Google Calendar API 上の event ID。upsert の冪等キー。
  google_event_id text not null,

  -- 所属カレンダー名 (例: パーソナル / MTG / 学習)。分類軸として使う。
  calendar_name text,

  -- 予定のタイトル。
  title text,

  start_at timestamptz not null,
  end_at timestamptz not null,

  is_deleted boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint google_calendar_events_user_event_unique
    unique (user_id, google_event_id)
);

create index google_calendar_events_user_target_date_idx
  on public.google_calendar_events (user_id, target_date);
-- Wake-based Timeline 用の重なり判定を高速化。
create index google_calendar_events_user_range_idx
  on public.google_calendar_events (user_id, start_at, end_at);

comment on table public.google_calendar_events is
  'Google Calendar の予定。所属カレンダー名 (calendar_name) で分類する。'
  '表示は target_date 一致ではなく wake range との重なりで判定するため'
  '(start_at, end_at) にもインデックスを張る。';
comment on column public.google_calendar_events.target_date is
  '主に start_at のユーザータイムゾーン上の日付。表示判定の主役は'
  '(start_at, end_at) と wake range の重なり。';
comment on column public.google_calendar_events.calendar_name is
  '所属カレンダー名。Today’s ME ではこれを分類軸に使う (色やラベルでは'
  '分類しない)。';
comment on column public.google_calendar_events.is_deleted is
  'ソフトデリートフラグ。同期時に Google 側から消えた既存予定に立てる。';

alter table public.google_calendar_events enable row level security;

create policy "google_calendar_events_select_own"
  on public.google_calendar_events
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "google_calendar_events_insert_own"
  on public.google_calendar_events
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "google_calendar_events_update_own"
  on public.google_calendar_events
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "google_calendar_events_delete_own"
  on public.google_calendar_events
  for delete
  to authenticated
  using (auth.uid() = user_id);


-- =============================================================================
-- 5. toggl_time_entries
-- =============================================================================
-- Toggl Track の作業ログ (time entries) を保持するテーブル。
--
-- 【タイトル単位での扱い (仕様 §3 分類ルール)】
-- Toggl はタイトル単位で扱う。ただし「別プロジェクト / 別 ID は別データ」と
-- して扱う (同名タイトルでも toggl_entry_id が違えば別行)。
--
-- 【end_at が null になり得る】
-- 現在進行中のエントリは Toggl 側で end_at が確定していないため null になる。
-- 同期完了後に end_at が埋まる想定。集計時は null チェック必須。
--
-- 【表示時の読み方】
-- Calendar 同様、wake range と (start_at, end_at) の重なりで判定する。
-- =============================================================================
create table public.toggl_time_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,

  -- 補助インデックス用。基本は start_at のユーザータイムゾーン上の日付。
  target_date date not null,

  -- Toggl API 上の time entry ID。upsert の冪等キー。
  toggl_entry_id text not null,

  -- エントリのタイトル (例: "Today’s ME 実装")。集計軸。
  title text,

  start_at timestamptz not null,

  -- 実行中エントリは null。同期完了時に確定する。
  end_at timestamptz,

  is_deleted boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint toggl_time_entries_user_entry_unique
    unique (user_id, toggl_entry_id)
);

create index toggl_time_entries_user_target_date_idx
  on public.toggl_time_entries (user_id, target_date);
-- Wake-based Timeline 用の重なり判定を高速化。
create index toggl_time_entries_user_range_idx
  on public.toggl_time_entries (user_id, start_at, end_at);

comment on table public.toggl_time_entries is
  'Toggl Track の作業ログ。タイトル単位で集計する (ただし toggl_entry_id が'
  '違えば別データ)。end_at は実行中の場合 null となるため集計時は要チェック。';
comment on column public.toggl_time_entries.end_at is
  '実行中エントリでは null。同期完了時に確定する。集計時は null 除外または'
  '現在時刻で打ち切るなどの処理を行う。';
comment on column public.toggl_time_entries.is_deleted is
  'ソフトデリートフラグ。同期時に Toggl 側から消えた既存エントリに立てる。';

alter table public.toggl_time_entries enable row level security;

create policy "toggl_time_entries_select_own"
  on public.toggl_time_entries
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "toggl_time_entries_insert_own"
  on public.toggl_time_entries
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "toggl_time_entries_update_own"
  on public.toggl_time_entries
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "toggl_time_entries_delete_own"
  on public.toggl_time_entries
  for delete
  to authenticated
  using (auth.uid() = user_id);
