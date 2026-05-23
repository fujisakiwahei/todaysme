-- =============================================================================
-- google_excluded_calendars: cover both call sites with a single composite
-- index that enables index-only scans (Issue #177)
--
-- 背景:
--   `/api/summary` の中で発行される
--     SELECT connection_id, calendar_id
--       FROM google_excluded_calendars
--      WHERE user_id = $1
--   が、同一トレース内の他の Supabase GET (200-300ms 帯) と比べて
--   ~740ms と 3 倍以上かかっていた。
--
--   既存のインデックスは:
--     - 主キー (connection_id, calendar_id)
--     - secondary: (user_id)
--   ``(user_id)`` の secondary は ``connection_id`` / ``calendar_id`` を
--   含まないため、Postgres は index → heap (visibility map + tuple fetch)
--   の経路を取らざるを得ず、行数が少なくても per-row オーバーヘッドが
--   ボトルネックになり得る (特に Supabase の cold connection 越し)。
--
--   呼び出し側:
--     1. server/api/summary.get.ts            … WHERE user_id = ?
--     2. server/api/connections/google/calendars.get.ts
--                                             … WHERE user_id = ? AND connection_id = ?
--   両方とも返却列は ``connection_id`` / ``calendar_id`` のみ。
--
-- 打ち手:
--   (user_id, connection_id) の B-tree に ``calendar_id`` を INCLUDE した
--   covering index を貼り、1) 2) のどちらも index-only scan で完結させる。
--   - 1) は leftmost prefix ``user_id`` のみで scan、INCLUDE 列から
--     ``calendar_id`` を直接読む (``connection_id`` はインデックスキー)。
--   - 2) は (user_id, connection_id) の両方を equality で絞り、
--     INCLUDE から ``calendar_id`` を読む。
--
--   旧 ``(user_id)`` 単独インデックスは新 index の leftmost prefix で
--   完全に代替できるので drop する。PK ``(connection_id, calendar_id)`` は
--   そのまま残す (一意性制約として必要なため)。
-- =============================================================================

create index if not exists google_excluded_calendars_user_conn_cal_idx
  on public.google_excluded_calendars (user_id, connection_id)
  include (calendar_id);

drop index if exists public.google_excluded_calendars_user_idx;
