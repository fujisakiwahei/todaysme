-- 本番テーブル一式
-- service_connections / daily_sync_statuses / oura_sleep_records /
-- google_calendar_events / toggl_time_entries
-- すべて RLS を有効化し、auth.uid() で行制限する。

-- =============================================================================
-- service_connections
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

comment on table public.service_connections is
  '外部サービス連携のトークン・メタ情報。トークンは AES-256-GCM 暗号化済みの blob として保存する。';
comment on column public.service_connections.access_token_encrypted is
  'AES-256-GCM で暗号化した access token。iv / authTag / ciphertext を含む blob。クライアントへ返してはならない。';
comment on column public.service_connections.refresh_token_encrypted is
  'AES-256-GCM で暗号化した refresh token。iv / authTag / ciphertext を含む blob。クライアントへ返してはならない。';

alter table public.service_connections enable row level security;

create policy "service_connections_select_own"
  on public.service_connections
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "service_connections_insert_own"
  on public.service_connections
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "service_connections_update_own"
  on public.service_connections
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "service_connections_delete_own"
  on public.service_connections
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- =============================================================================
-- daily_sync_statuses
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

comment on table public.daily_sync_statuses is
  'ユーザー × 対象日 × サービス単位の同期ステータス。多重実行ロックの境界も兼ねる。';

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
-- oura_sleep_records
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

comment on column public.oura_sleep_records.target_date is
  'ユーザータイムゾーンにおける wake_at の日付（Issue #24）。睡眠開始日ではない。';

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
-- google_calendar_events
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

comment on column public.google_calendar_events.target_date is
  '主に start_at のユーザータイムゾーン上の日付。表示時は wake range との重なりで判定する。';

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
-- toggl_time_entries
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

comment on column public.toggl_time_entries.end_at is
  '実行中エントリは null。同期完了時に確定する。';

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
