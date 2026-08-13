-- =============================================================================
-- 終了済みの空き時間に、ユーザーが実績メモを残すためのテーブル。
--
-- gap_start_at / gap_end_at は保存時点の区間をスナップショットとして保持する。
-- 後から Calendar / Toggl の同期結果が変わっても自動更新しない。
-- =============================================================================

create table public.free_time_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  target_date date not null,
  gap_start_at timestamptz not null,
  gap_end_at timestamptz not null,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint free_time_notes_valid_range_check
    check (gap_start_at < gap_end_at),
  constraint free_time_notes_content_length_check
    check (char_length(btrim(content)) between 1 and 1000),
  constraint free_time_notes_user_range_unique
    unique (user_id, gap_start_at, gap_end_at)
);

create index free_time_notes_user_target_date_idx
  on public.free_time_notes (user_id, target_date, gap_start_at);

alter table public.free_time_notes enable row level security;

create policy "free_time_notes_select_own"
  on public.free_time_notes
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "free_time_notes_insert_own"
  on public.free_time_notes
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "free_time_notes_update_own"
  on public.free_time_notes
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "free_time_notes_delete_own"
  on public.free_time_notes
  for delete
  to authenticated
  using (auth.uid() = user_id);
