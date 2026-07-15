-- =============================================================================
-- Todoist 連携 (Issue #206)
--
--   日記用 Markdown コピー機能の「完了タスク」セクションのために Todoist を
--   4 つ目の連携サービスとして追加する。
--
--   1. service_connections.provider / daily_sync_statuses.source の CHECK 制約に
--      'todoist' を追加。
--   2. Oura / Toggl 用の partial unique index (1 ユーザー × 1 行の強制) に
--      todoist を追加。Todoist も API token 方式 (refresh 概念なし) のため
--      Toggl と同じ「単一行」モデルで扱う。
--   3. todoist_completed_tasks テーブルを新設。既存テーブル群と同じ規約
--      (RLS 有効化 / ソフトデリート / user_id + 外部キー unique) に従う。
--
--   外部 API は Todoist API v1 (unified)。Sync API v9 の completed/get_all は
--   非推奨のため使わない。
-- =============================================================================


-- =============================================================================
-- 1. provider / source の CHECK 制約に 'todoist' を追加
-- =============================================================================
alter table public.service_connections
  drop constraint service_connections_provider_check;

alter table public.service_connections
  add constraint service_connections_provider_check
    check (provider in ('oura', 'google', 'toggl', 'todoist'));

alter table public.daily_sync_statuses
  drop constraint daily_sync_statuses_source_check;

alter table public.daily_sync_statuses
  add constraint daily_sync_statuses_source_check
    check (source in ('oura', 'google', 'toggl', 'todoist'));


-- =============================================================================
-- 2. 単一行 provider 用 partial unique index に todoist を追加
--    (Phase 1b: 20260522062000 で作成したものを置き換える)
-- =============================================================================
drop index public.service_connections_single_provider_unique;

create unique index service_connections_single_provider_unique
  on public.service_connections (user_id, provider)
  where provider in ('oura', 'toggl', 'todoist');


-- =============================================================================
-- 3. todoist_completed_tasks
--
--   - todoist_event_key: `${todoist_task_id}:${completed_at ISO}` の合成キー。
--     繰り返しタスク (recurring) は同じ task_id で複数回完了しうるため、
--     「1 回の完了」を一意に識別するにはこの合成が必要。upsert の
--     onConflict / ソフトデリート判定の外部キーとして使う。
--   - project_id / project_name: Todoist API v1 の project id は文字列。
--     project 名は同期時に /projects から解決して非正規化保存する
--     (toggl_time_entries.project_name と同じ流儀)。
-- =============================================================================
create table public.todoist_completed_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  target_date date not null,
  todoist_event_key text not null,
  todoist_task_id text not null,
  content text,
  project_id text,
  project_name text,
  completed_at timestamptz not null,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint todoist_completed_tasks_user_event_unique
    unique (user_id, todoist_event_key)
);

create index todoist_completed_tasks_user_target_date_idx
  on public.todoist_completed_tasks (user_id, target_date);
create index todoist_completed_tasks_user_completed_at_idx
  on public.todoist_completed_tasks (user_id, completed_at);

alter table public.todoist_completed_tasks enable row level security;

create policy "todoist_completed_tasks_select_own"
  on public.todoist_completed_tasks
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "todoist_completed_tasks_insert_own"
  on public.todoist_completed_tasks
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "todoist_completed_tasks_update_own"
  on public.todoist_completed_tasks
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "todoist_completed_tasks_delete_own"
  on public.todoist_completed_tasks
  for delete
  to authenticated
  using (auth.uid() = user_id);
