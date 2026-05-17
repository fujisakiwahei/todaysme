-- =============================================================================
-- public.users
-- =============================================================================
--
-- 【概要】
-- Supabase Auth が管理する `auth.users`（メールアドレス・ログイン情報など認証
-- に関わる部分）と 1:1 で対応する「アプリ固有のユーザープロファイル」。
-- アプリ側で必要なユーザー属性（タイムゾーン等）はこちらに持たせる。
--
-- 【なぜ auth.users と分けるのか】
-- auth.users は Supabase Auth がスキーマも含めて管理するため、こちらが自由に
-- カラムを足したりインデックスを張ったりすることは推奨されない。
-- アプリ固有の属性は public 配下の自分のテーブルに持ち、PK を auth.users.id と
-- 共有することで「ログインユーザー = アプリユーザー」を 1:1 で対応させる。
--
-- 【用語】
-- - `auth.uid()`  ... Supabase Auth が JWT から取り出してくれる現在のユーザー
--                     ID（UUID）。RLS ポリシー内で「自分の行だけ見せる」判定に
--                     利用する。
-- - `timezone`    ... IANA タイムゾーン名（例: `Asia/Tokyo`）。Oura の
--                     `target_date` 算出（起床日基準）や、Wake-based Timeline
--                     のレンダリング基準として使う。
--
-- 【構造】
-- auth.users (Supabase Auth 管理)
--    └─ public.users (id を共有, 1:1)
--          ├─ service_connections        (1:N: 連携サービスごと)
--          ├─ daily_sync_statuses        (1:N: 対象日 × サービス)
--          ├─ oura_sleep_records         (1:N)
--          ├─ google_calendar_events     (1:N)
--          └─ toggl_time_entries         (1:N)
-- =============================================================================

create table public.users (
  -- auth.users.id と同一 UUID を共有することで「ログインユーザー = アプリユーザー」
  -- を保証する。auth.users 側が消えたら CASCADE でこちらも消える。
  id uuid primary key references auth.users (id) on delete cascade,

  -- IANA タイムゾーン。Oura 睡眠の wake_at をどの暦日に紐づけるかや、
  -- Wake-based Timeline の表示基準時刻に使う。MVP は単一ユーザーで Asia/Tokyo を想定。
  timezone text not null default 'Asia/Tokyo',

  created_at timestamptz not null default now()
);

comment on table public.users is
  'Supabase Auth (auth.users) と 1:1 対応するアプリ固有のユーザープロファイル。'
  'アプリで必要な属性 (timezone 等) はこちらに格納する。';
comment on column public.users.id is
  'auth.users.id と同じ UUID。auth.users の削除に追従する (ON DELETE CASCADE)。';
comment on column public.users.timezone is
  'IANA タイムゾーン名。Oura の target_date 算出 (起床日基準) や Timeline の'
  '基準時刻として使用する。';

-- -----------------------------------------------------------------------------
-- auth.users への INSERT を捕捉して public.users にも行を作るトリガー
-- -----------------------------------------------------------------------------
-- 新規サインアップ時、Supabase Auth は auth.users に行を作るだけで、こちらの
-- public.users には触れない。アプリ層で「ログイン後に毎回 users 行の存在を
-- 確認して無ければ作る」よりも、DB トリガーで自動同期するほうが取りこぼしが
-- ない。SECURITY DEFINER で関数を public 所有として走らせ、auth スキーマへの
-- 権限を持つ Supabase システムロールから安全に呼び出させる。
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
-- RLS: 自分の行だけ見える / 更新できる
-- -----------------------------------------------------------------------------
-- RLS (Row Level Security) ... ロール (authenticated / anon / service_role) と
-- ポリシーの組み合わせで、SQL レイヤで「どの行を見せるか」を制御する仕組み。
-- ここでは authenticated ロール (= JWT 経由でログイン中のユーザー) に対して
-- 「id = auth.uid() の行のみ操作可」というルールを敷く。
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
