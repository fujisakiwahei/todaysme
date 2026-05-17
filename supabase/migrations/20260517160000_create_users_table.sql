-- =============================================================================
-- public.users
-- Supabase Auth (auth.users) と 1:1 で対応するアプリ固有のユーザープロファイル。
-- auth.users への INSERT を捕捉するトリガーで行を自動生成する。
-- 解説: PR #59 コメントを参照。
-- =============================================================================

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  timezone text not null default 'Asia/Tokyo',
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- auth.users への INSERT を public.users にも反映するトリガー
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- RLS
-- auth.uid() は、JWTに含まれている
-- -----------------------------------------------------------------------------
alter table public.users enable row level security;

create policy "users_select_own"
  on public.users
  for select
  to authenticated
  using (auth.uid() = id);

create policy "users_update_own"
  on public.users
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);
