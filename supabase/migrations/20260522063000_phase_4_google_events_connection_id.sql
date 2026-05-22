-- =============================================================================
-- 複数 Google アカウント連携 Phase 4 (Issue #131 / 設計ドラフト
-- docs/designs/multi-google-account.md §4.1 / §4.3 / §6)
--
-- 目的:
--   google_calendar_events に `connection_id` 列を追加し、unique 制約を
--   `(user_id, connection_id, calendar_id, google_event_id)` に張り替える。
--
--   これにより:
--     - 別アカウント (= 別 connection_id) で同じ event.id / calendar_id が
--       出てきても別 row として扱える (calendar_id がアカウント間で
--       たまたま衝突する可能性に備えた防御策)。
--     - softDeleteEventsForRemovedCalendars を connection_id 単位で
--       スコープできるようになり、「アカウント A の同期がアカウント B の
--       イベントを誤削除する」事故を防げる (設計 §3.1 / §4.3)。
--
-- 順序の制約:
--   - 適用前提: Phase 1b の partial unique index 2 本が張られている
--     (= 20260522062000 適用済み)。本マイグレーションは既存 google
--     接続行から connection_id を backfill するため、Google 接続行が
--     `provider_user_id` を持つ "本番" 状態であることを期待する。
--   - 既存行の connection_id 推定は「同 user の唯一の Google 接続行」を
--     探す。MVP は単一ユーザー × 単一 Google アカウント運用なので、ここは
--     `limit 1` で済む。Phase 3 で 2 アカウント目を追加した直後で本
--     マイグレーションが流れる順序になることは無い (本マイグは Phase 3
--     よりも先行する設計順)。
-- =============================================================================

-- 1. connection_id 列を追加 (nullable で開始 → backfill → NOT NULL に締める)。
alter table public.google_calendar_events
  add column connection_id uuid;

-- 2. 既存行を backfill。「同 user の Google 接続行」を 1 件取って紐付ける。
--    Phase 3 適用前 (= 単一 Google アカウントしかない) を想定。
--    複数行に紐付くケース (LIMIT 1 が複数候補から拾うケース) は MVP では発生
--    しないが、念のため不一致を検出できるよう backfill 後にチェックを行う。
update public.google_calendar_events ev
   set connection_id = sc.id
  from public.service_connections sc
 where sc.user_id = ev.user_id
   and sc.provider = 'google'
   and ev.connection_id is null;

-- 3. 監査: backfill 後に NULL が残っていれば failsafe で止める。
--    NULL が残るのは「対応する Google 接続行がそもそも存在しない」古いゴミ
--    データのみ。MVP では 0 件のはず。
do $$
declare
  unbackfilled integer;
begin
  select count(*) into unbackfilled
    from public.google_calendar_events
   where connection_id is null;

  if unbackfilled > 0 then
    raise exception
      'Phase 4 backfill incomplete: % google_calendar_events rows still have NULL connection_id (no matching service_connections row).',
      unbackfilled;
  end if;
end$$;

-- 4. NOT NULL を付ける。以後 sync 経路はすべて connection_id を埋める。
alter table public.google_calendar_events
  alter column connection_id set not null;

-- 5. FK 制約: 接続行が物理的に消えたら events も巻き取って消える。
--    MVP では disconnect 系統は soft (status='disconnected') で済ませているため
--    cascade は実質発火しないが、論理整合性のため宣言する。
alter table public.google_calendar_events
  add constraint google_calendar_events_connection_fk
    foreign key (connection_id)
    references public.service_connections (id)
    on delete cascade;

-- 6. unique 制約を connection_id 込みへ張替。
--    旧: (user_id, calendar_id, google_event_id)
--    新: (user_id, connection_id, calendar_id, google_event_id)
alter table public.google_calendar_events
  drop constraint google_calendar_events_user_calendar_event_unique;

alter table public.google_calendar_events
  add constraint google_calendar_events_user_connection_calendar_event_unique
    unique (user_id, connection_id, calendar_id, google_event_id);

-- 7. sync 同期で「同一接続内の取得結果に含まれない既存行をソフトデリート」する
--    sweep クエリが connection_id 単位で絞れるよう、補助 index を張る。
create index if not exists google_calendar_events_connection_target_idx
  on public.google_calendar_events (user_id, connection_id, target_date);
