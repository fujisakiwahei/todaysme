-- =============================================================================
-- 本番テーブル一式
--   1. service_connections      ... 外部サービス連携のトークン・メタ情報
--   2. daily_sync_statuses      ... ユーザー × 対象日 × サービス単位の同期状態
--   3. oura_sleep_records       ... Oura 睡眠データ
--   4. google_calendar_events   ... Google Calendar 予定
--   5. toggl_time_entries       ... Toggl Track 作業ログ
--
-- 用語・構造・各テーブルの設計意図の解説は PR #59 コメントを参照。
-- =============================================================================


-- =============================================================================
-- 1. service_connections
-- =============================================================================
create table public.service_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  provider text not null,
  status text not null default 'connected',
  provider_user_id text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  scopes text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_connections_provider_check
    check (provider in ('oura', 'google', 'toggl')),
  constraint service_connections_status_check
    check (status in ('connected', 'disconnected', 'error')),
  constraint service_connections_user_provider_unique
    unique (user_id, provider)
);

create index service_connections_user_id_idx on public.service_connections (user_id);

alter table public.service_connections enable row level security;
alter table public.service_connections force row level security;


-- =============================================================================
-- 2. daily_sync_statuses
-- =============================================================================
create table public.daily_sync_statuses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  target_date date not null,
  source text not null,
  status text not null default 'idle',
  sync_started_at timestamptz,
  last_synced_at timestamptz,
  error_message text,
  updated_at timestamptz not null default now(),
  constraint daily_sync_statuses_source_check
    check (source in ('oura', 'google', 'toggl')),
  constraint daily_sync_statuses_status_check
    check (status in ('idle', 'in_progress', 'success', 'failed')),
  constraint daily_sync_statuses_user_date_source_unique
    unique (user_id, target_date, source)
);

create index daily_sync_statuses_user_date_idx
  on public.daily_sync_statuses (user_id, target_date);

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
create table public.oura_sleep_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  target_date date not null,
  oura_sleep_id text not null,
  sleep_start_at timestamptz not null,
  wake_at timestamptz not null,
  sleep_minutes integer,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint oura_sleep_records_user_sleep_unique
    unique (user_id, oura_sleep_id)
);

create index oura_sleep_records_user_target_date_idx
  on public.oura_sleep_records (user_id, target_date);
create index oura_sleep_records_user_range_idx
  on public.oura_sleep_records (user_id, sleep_start_at, wake_at);

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
create table public.google_calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  target_date date not null,
  google_event_id text not null,
  calendar_name text,
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
create index google_calendar_events_user_range_idx
  on public.google_calendar_events (user_id, start_at, end_at);

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
create table public.toggl_time_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  target_date date not null,
  toggl_entry_id text not null,
  title text,
  start_at timestamptz not null,
  end_at timestamptz,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint toggl_time_entries_user_entry_unique
    unique (user_id, toggl_entry_id)
);

create index toggl_time_entries_user_target_date_idx
  on public.toggl_time_entries (user_id, target_date);
create index toggl_time_entries_user_range_idx
  on public.toggl_time_entries (user_id, start_at, end_at);

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
