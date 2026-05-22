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
--   - 上記前提を守れているか pre-update guard で明示的に検証する。Google
--     接続行が同 user に複数ある状態で `UPDATE ... FROM` を流すと JOIN が
--     非決定的に 1 件を拾い、events が誤った接続に紐付くため
--     (Codex review #136 P1)、ambiguity を観測した時点で exception で
--     止める。
-- =============================================================================

-- 1. connection_id 列を追加 (nullable で開始 → backfill → NOT NULL に締める)。
alter table public.google_calendar_events
  add column connection_id uuid;

-- 2. Pre-update guard: 同 user に Google 接続行が 2 件以上ある状態で本マイグを
--    流すと、UPDATE ... FROM の JOIN が複数候補から非決定的に 1 件を拾い、
--    events が誤った接続に紐付く可能性がある (Codex review #136 P1)。
--    Phase 4 は Phase 3 (UI 上の「別のアカウントを追加」導線) よりも先行する
--    設計順なので、ここで >=2 件が観測されたら設計順違反として止める。
do $$
declare
  ambiguous_users integer;
begin
  select count(*) into ambiguous_users
    from (
      select user_id
        from public.service_connections
       where provider = 'google'
       group by user_id
      having count(*) > 1
    ) t;

  if ambiguous_users > 0 then
    raise exception
      'Phase 4 backfill aborted: % user(s) have multiple google service_connections rows at migration time. Apply this migration before Phase 3 introduces multi-account, or manually resolve the duplicates first (UPDATE...FROM cannot deterministically map events to a single connection in this state).',
      ambiguous_users;
  end if;
end$$;

-- 3. 既存行を backfill。Guard により「同 user の Google 接続行は最大 1 件」が
--    保証されているため、JOIN は決定的に 1 行へ収束する。
update public.google_calendar_events ev
   set connection_id = sc.id
  from public.service_connections sc
 where sc.user_id = ev.user_id
   and sc.provider = 'google'
   and ev.connection_id is null;

-- 4. 監査: backfill 後に NULL が残っていれば failsafe で止める。
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

-- 5. NOT NULL を付ける。以後 sync 経路はすべて connection_id を埋める。
alter table public.google_calendar_events
  alter column connection_id set not null;

-- 6. FK 制約: 接続行が物理的に消えたら events も巻き取って消える。
--    MVP では disconnect 系統は soft (status='disconnected') で済ませているため
--    cascade は実質発火しないが、論理整合性のため宣言する。
alter table public.google_calendar_events
  add constraint google_calendar_events_connection_fk
    foreign key (connection_id)
    references public.service_connections (id)
    on delete cascade;

-- 7. unique 制約を connection_id 込みへ張替。
--    旧: (user_id, calendar_id, google_event_id)
--    新: (user_id, connection_id, calendar_id, google_event_id)
alter table public.google_calendar_events
  drop constraint google_calendar_events_user_calendar_event_unique;

alter table public.google_calendar_events
  add constraint google_calendar_events_user_connection_calendar_event_unique
    unique (user_id, connection_id, calendar_id, google_event_id);

-- 8. sync 同期で「同一接続内の取得結果に含まれない既存行をソフトデリート」する
--    sweep クエリが connection_id 単位で絞れるよう、補助 index を張る。
create index if not exists google_calendar_events_connection_target_idx
  on public.google_calendar_events (user_id, connection_id, target_date);
