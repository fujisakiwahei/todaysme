-- =============================================================================
-- 複数 Google アカウント連携 Phase 5 (Issue #131 / 設計
-- docs/designs/multi-google-account.md §4.1 / §4.2 / §6)
--
-- 目的:
--   稼働時間集計から除外する Google カレンダーを「接続単位」で管理する。
--   旧来は `users.excluded_google_calendar_ids text[]` (1 ユーザー × 1 配列)
--   だったが、ユーザーが複数 Google アカウントを連携できるようになると
--   「同じ calendar_id がアカウント間で別物を指す」可能性があり、
--   配列方式では区別できないため (connection_id, calendar_id) を主キーに
--   持つテーブルへ移行する。
--
-- 設計上の注意:
--   - `users.excluded_google_calendar_ids` は **drop しない**。アプリケーション
--     経路は本マイグレーション以降この新テーブルだけを読み書きするが、
--     万一のロールバック / 監査用に旧データをそのまま残す。将来別マイグで drop。
--   - 既存行の backfill は「対象 user の Google 接続行すべて」に
--     旧配列の内容を複製する。MVP では 1 ユーザー × 1 Google 接続が前提
--     (Phase 1b 完了後 / Phase 3 アカウント追加が動く前) なので、複数接続が
--     既に存在する万一のケースでは全接続に同じ除外設定が初期コピーされる
--     (= 後でユーザーが接続別に編集すれば良い)。
--   - Phase 4 で google_calendar_events.connection_id NOT NULL 制約まで通って
--     いる前提。本テーブルの FK 先 service_connections は ON DELETE CASCADE
--     で、接続行が物理削除された場合 (本 MVP では soft disconnect のみだが)
--     除外設定も巻き取って消える。
-- =============================================================================

-- 1. テーブル作成。
--    (connection_id, calendar_id) を主キーにし、同接続内で同 calendar_id が
--    複数行にならないようにする。user_id は RLS と検索用に冗長保持。
create table public.google_excluded_calendars (
  user_id        uuid not null references public.users (id) on delete cascade,
  connection_id  uuid not null references public.service_connections (id) on delete cascade,
  calendar_id    text not null,
  created_at     timestamptz not null default now(),
  primary key (connection_id, calendar_id)
);

-- user 単位の検索を高速化 (summary.get.ts は user_id で in-bulk 読み込み)。
create index google_excluded_calendars_user_idx
  on public.google_excluded_calendars (user_id);

-- 2. backfill: 既存の users.excluded_google_calendar_ids を、当該 user が
--    現在持っている Google 接続行すべてにコピーする。
--    - jsonb / text[] の `unnest` で配列を展開。
--    - 同 user に Google 接続行が存在しない場合は何も挿入されない (= 旧
--      除外設定は実害なく失効する。次回 Google 連携時にユーザーが選び直す)。
--    - 同 user × 同 connection_id × 同 calendar_id の二重 INSERT は
--      ON CONFLICT DO NOTHING で吸収 (再実行時 idempotent)。
insert into public.google_excluded_calendars (user_id, connection_id, calendar_id)
select
  u.id            as user_id,
  sc.id           as connection_id,
  unnest(u.excluded_google_calendar_ids) as calendar_id
from public.users u
join public.service_connections sc
  on sc.user_id = u.id
 and sc.provider = 'google'
where u.excluded_google_calendar_ids is not null
  and array_length(u.excluded_google_calendar_ids, 1) is not null
on conflict (connection_id, calendar_id) do nothing;

-- 3. RLS: auth.uid() = user_id の行だけ操作可能にする。
alter table public.google_excluded_calendars enable row level security;

create policy "google_excluded_calendars_select_own"
  on public.google_excluded_calendars
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "google_excluded_calendars_insert_own"
  on public.google_excluded_calendars
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "google_excluded_calendars_update_own"
  on public.google_excluded_calendars
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "google_excluded_calendars_delete_own"
  on public.google_excluded_calendars
  for delete
  to authenticated
  using (auth.uid() = user_id);
