-- デモ専用テーブル
-- 公開デモ（/demo, /demo/daily/[date]）はログイン不要・外部 API 不要で動かす。
-- 本番テーブルとは完全に分離し、anon でも SELECT 可能な RLS を設定する。

-- =============================================================================
-- demo_oura_sleep_records
-- =============================================================================
create table public.demo_oura_sleep_records (
  id uuid primary key default gen_random_uuid(),
  target_date date not null,
  oura_sleep_id text not null,
  sleep_start_at timestamptz not null,
  wake_at timestamptz not null,
  sleep_minutes integer,
  is_deleted boolean not null default false,
  constraint demo_oura_sleep_records_sleep_id_unique unique (oura_sleep_id)
);

create index demo_oura_sleep_records_target_date_idx
  on public.demo_oura_sleep_records (target_date);

alter table public.demo_oura_sleep_records enable row level security;

create policy "demo_oura_sleep_records_public_read"
  on public.demo_oura_sleep_records
  for select
  to anon, authenticated
  using (true);

-- =============================================================================
-- demo_google_calendar_events
-- =============================================================================
create table public.demo_google_calendar_events (
  id uuid primary key default gen_random_uuid(),
  target_date date not null,
  google_event_id text not null,
  calendar_name text,
  title text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  is_deleted boolean not null default false,
  constraint demo_google_calendar_events_event_id_unique unique (google_event_id)
);

create index demo_google_calendar_events_target_date_idx
  on public.demo_google_calendar_events (target_date);

alter table public.demo_google_calendar_events enable row level security;

create policy "demo_google_calendar_events_public_read"
  on public.demo_google_calendar_events
  for select
  to anon, authenticated
  using (true);

-- =============================================================================
-- demo_toggl_time_entries
-- =============================================================================
create table public.demo_toggl_time_entries (
  id uuid primary key default gen_random_uuid(),
  target_date date not null,
  toggl_entry_id text not null,
  title text,
  start_at timestamptz not null,
  end_at timestamptz,
  is_deleted boolean not null default false,
  constraint demo_toggl_time_entries_entry_id_unique unique (toggl_entry_id)
);

create index demo_toggl_time_entries_target_date_idx
  on public.demo_toggl_time_entries (target_date);

alter table public.demo_toggl_time_entries enable row level security;

create policy "demo_toggl_time_entries_public_read"
  on public.demo_toggl_time_entries
  for select
  to anon, authenticated
  using (true);
