-- public.users
-- Supabase Auth (auth.users) と 1:1 で対応する公開プロファイルテーブル。
-- 各 user 紐づきテーブルは public.users.id を FK として参照する。

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  timezone text not null default 'Asia/Tokyo',
  created_at timestamptz not null default now()
);

comment on table public.users is 'Supabase Auth と 1:1 対応するアプリ固有のユーザープロファイル';
comment on column public.users.timezone is 'IANA タイムゾーン名（例: Asia/Tokyo）。target_date 算出やタイムライン描画で使用する。';

-- auth.users への挿入を検知して public.users にも行を作る
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

-- RLS
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
