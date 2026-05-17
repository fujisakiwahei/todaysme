-- =============================================================================
-- デモ専用テーブル
-- =============================================================================
--
-- 【目的】
-- 公開デモ (`/demo`, `/demo/daily/[date]`) を ログイン不要 / 外部 API 不要 で
-- 動かすための、本番テーブルとは完全に分離されたデータ置き場。
-- 仕様 §11.4 でも「デモは本番テーブルと分離」と明記されている。
--
-- 【なぜ本番テーブルと相乗りしないか】
-- - 本番テーブルの RLS は `auth.uid() = user_id` を前提にしているため、デモ
--   閲覧時に anon ロールへ無理に穴を開けると、本番ユーザーのデータが漏れる
--   リスクが生まれる
-- - デモ用ダミーユーザーを作って相乗りさせるとデータ管理がやりにくくなる
-- - 別テーブルにしておけば、デモ seed の入れ替えや誤って消す事故も切り離せる
--
-- 【本番テーブルとの構造差分】
-- - user_id を持たない (誰のものでもないため)
-- - 暗号化トークンを扱わない (外部 API を叩かないため service_connections 相当は不要)
-- - 同期ステータスも持たない (静的データのため)
-- - 外部 ID (oura_sleep_id / google_event_id / toggl_entry_id) はテーブル全体
--   での unique にする (本番側は (user_id, *_id) の複合 unique)
--
-- 【RLS の方針】
-- anon と authenticated の両方に SELECT のみ許可。INSERT/UPDATE/DELETE は
-- service_role からマイグレーション/seed 経由でのみ行う。
-- =============================================================================


-- =============================================================================
-- demo_oura_sleep_records
-- =============================================================================
-- デモ用の睡眠データ。本番 oura_sleep_records と同じスキーマ意図 (target_date
-- は起床日 / Issue #24) だが user_id を持たない。
-- =============================================================================
create table public.demo_oura_sleep_records (
  id uuid primary key default gen_random_uuid(),

  -- 起床日 (本番と同じ運用: wake_at の日付)。
  target_date date not null,

  -- Oura API 風の擬似 ID。テーブル全体で unique。
  oura_sleep_id text not null,

  sleep_start_at timestamptz not null,
  wake_at timestamptz not null,
  sleep_minutes integer,

  -- 表示ロジックを本番と同形にするためのソフトデリート用フラグ。
  -- デモ運用では基本 false のまま使う。
  is_deleted boolean not null default false,

  constraint demo_oura_sleep_records_sleep_id_unique unique (oura_sleep_id)
);

create index demo_oura_sleep_records_target_date_idx
  on public.demo_oura_sleep_records (target_date);

comment on table public.demo_oura_sleep_records is
  '公開デモ用の Oura 睡眠データ。本番 oura_sleep_records と同形だが user_id を'
  '持たず、anon ロールから SELECT 可能。';

alter table public.demo_oura_sleep_records enable row level security;

create policy "demo_oura_sleep_records_public_read"
  on public.demo_oura_sleep_records
  for select
  to anon, authenticated
  using (true);


-- =============================================================================
-- demo_google_calendar_events
-- =============================================================================
-- デモ用の Google Calendar 予定。本番と同様に calendar_name で分類軸を持つ。
-- =============================================================================
create table public.demo_google_calendar_events (
  id uuid primary key default gen_random_uuid(),
  target_date date not null,

  -- Google Calendar API 風の擬似 ID。テーブル全体で unique。
  google_event_id text not null,

  -- 所属カレンダー名 (例: パーソナル / MTG / 学習 / 予定ブロック)。
  calendar_name text,

  -- 予定のタイトル。
  title text,

  start_at timestamptz not null,
  end_at timestamptz not null,

  is_deleted boolean not null default false,

  constraint demo_google_calendar_events_event_id_unique unique (google_event_id)
);

create index demo_google_calendar_events_target_date_idx
  on public.demo_google_calendar_events (target_date);

comment on table public.demo_google_calendar_events is
  '公開デモ用の Google Calendar 予定。calendar_name で分類する。anon ロールから'
  ' SELECT 可能。';

alter table public.demo_google_calendar_events enable row level security;

create policy "demo_google_calendar_events_public_read"
  on public.demo_google_calendar_events
  for select
  to anon, authenticated
  using (true);


-- =============================================================================
-- demo_toggl_time_entries
-- =============================================================================
-- デモ用の Toggl 作業ログ。本番と同じく end_at は null を許容するが、デモ運用
-- では原則埋めておく。
-- =============================================================================
create table public.demo_toggl_time_entries (
  id uuid primary key default gen_random_uuid(),
  target_date date not null,

  -- Toggl API 風の擬似 ID。テーブル全体で unique。
  toggl_entry_id text not null,

  -- エントリのタイトル (例: "Today’s ME 実装")。集計軸。
  title text,

  start_at timestamptz not null,

  -- 本番との形状揃えのため null 許容にしているが、デモ seed では基本確定値。
  end_at timestamptz,

  is_deleted boolean not null default false,

  constraint demo_toggl_time_entries_entry_id_unique unique (toggl_entry_id)
);

create index demo_toggl_time_entries_target_date_idx
  on public.demo_toggl_time_entries (target_date);

comment on table public.demo_toggl_time_entries is
  '公開デモ用の Toggl 作業ログ。タイトル単位で集計する。anon ロールから'
  ' SELECT 可能。';

alter table public.demo_toggl_time_entries enable row level security;

create policy "demo_toggl_time_entries_public_read"
  on public.demo_toggl_time_entries
  for select
  to anon, authenticated
  using (true);
