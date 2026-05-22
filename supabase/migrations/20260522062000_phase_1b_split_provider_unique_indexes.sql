-- =============================================================================
-- 複数 Google アカウント連携 Phase 1b (Issue #131 / 設計ドラフト
-- docs/designs/multi-google-account.md §4.1 / §6)
--
-- 目的:
--   Phase 2 で全 Google 接続行に provider_user_id (sub) が backfill された
--   ことを前提に、unique 制約を「provider 別の partial unique index」に
--   置き換える。これにより
--     - Google: 同一ユーザーが (sub 別の) 複数行を持てる
--     - Oura / Toggl: 同一ユーザーで 1 行のまま (NULL 重複問題を回避)
--   という非対称な制約を表現する。
--
-- 順序の制約 (設計 §4.1 / §4.2 (3) / §6):
--   - 適用前提: provider='google' AND provider_user_id IS NULL な行が 0 件。
--     人手でユーザーに再認可を踏ませて Phase 2 callback で backfill した
--     状態のみで本マイグレーションを流すこと。NULL 持ち旧行が残ったまま
--     3 列 partial unique を張ると、PostgreSQL の合成 unique が NULL を
--     distinct と見なすため、NULL 行と sub 持ち行が同 user / 同 provider で
--     共存できてしまう (Codex review #127 P1)。
--   - 本マイグレーションの先頭で DO ブロックの assert を行い、NULL 残存が
--     あれば exception で止める (= migration が走らない / 後段の DDL は
--     1 つも実行されない)。
--   - また、PostgREST の upsert({onConflict}) は partial unique index に
--     推論マッチしないため (`42P10`)、本マイグレーションと同 PR の
--     upsertServiceConnection 書き換え (explicit SELECT → UPDATE/INSERT)
--     とセットで適用する必要がある。
-- =============================================================================

-- 1. ガード: backfill 完了確認。Phase 2 で全行 backfill されていれば 0 件。
do $$
declare
  legacy_count integer;
begin
  select count(*)
    into legacy_count
    from public.service_connections
   where provider = 'google'
     and provider_user_id is null;

  if legacy_count > 0 then
    raise exception
      'Phase 1b prerequisite failed: % google rows still have NULL provider_user_id. Re-auth via /settings to backfill provider_user_id before applying this migration.',
      legacy_count;
  end if;
end$$;

-- 2. 旧 unique(user_id, provider) constraint を drop。
--    Oura / Toggl はこの後に partial unique を張り直すので、ここで一旦
--    完全に外す (constraint と index が同名なので drop constraint だけで OK)。
alter table public.service_connections
  drop constraint service_connections_user_provider_unique;

-- 3. Phase 1a で張った過渡期用 partial unique index を drop。
--    本番用 (下の Google 用) と意味的に重複するため。
drop index if exists public.service_connections_google_legacy_unique;

-- 4. Google 用 partial unique index: (user_id, provider, provider_user_id)
--    where provider = 'google'。複数アカウントぶんの行を許容する。
--    `provider_user_id` を NOT NULL にせずに「provider='google' なら埋まっている
--    こと」をアプリ層 + Phase 2 backfill の前提に委ねる (制約まで強制すると
--    Oura / Toggl 行の挿入が壊れる)。
create unique index service_connections_google_unique
  on public.service_connections (user_id, provider, provider_user_id)
  where provider = 'google';

-- 5. Oura / Toggl 用 partial unique index: (user_id, provider) where provider
--    in ('oura', 'toggl')。`provider_user_id` 不在のまま「1 ユーザー × 1 行」
--    を物理的に強制できる (NULL 重複が起きない / loadConnectionForToken の
--    .maybeSingle() 前提が壊れない)。
create unique index service_connections_single_provider_unique
  on public.service_connections (user_id, provider)
  where provider in ('oura', 'toggl');
