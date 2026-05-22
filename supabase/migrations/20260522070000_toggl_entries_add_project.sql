-- =============================================================================
-- toggl_time_entries / demo_toggl_time_entries にプロジェクト情報を追加
-- Issue #112
--
-- Toggl Track の time entry には `project_id` (number) のみが載り、
-- プロジェクト名は `/api/v9/me/projects` から別途取得する必要がある。
-- MVP では別テーブル化せず、同期時に解決した `project_id` / `project_name` を
-- そのまま time entry 行に持たせる (Toggl 側でリネームされても次回同期で
-- 上書きされる前提)。
--
-- いずれもサービス側で project 未割当のエントリが存在しうるため nullable。
-- 既存行は project 未解決として NULL のまま残し、次回 sync で埋まる。
-- =============================================================================

-- 本番テーブル
alter table public.toggl_time_entries
  add column if not exists project_id bigint,
  add column if not exists project_name text;

-- デモテーブル
alter table public.demo_toggl_time_entries
  add column if not exists project_id bigint,
  add column if not exists project_name text;

-- デモデータにもプロジェクト名を埋めておく (UI 確認用)。
-- 既存 seed (20260517160300) は project_id/project_name を持たないので
-- ここでまとめて UPDATE する。
update public.demo_toggl_time_entries
   set project_id = 1001, project_name = 'Today''s ME'
 where toggl_entry_id in (
   'demo-toggl-2026-05-15-01',
   'demo-toggl-2026-05-15-03',
   'demo-toggl-2026-05-16-02',
   'demo-toggl-2026-05-17-01',
   'demo-toggl-2026-05-17-03'
 );

update public.demo_toggl_time_entries
   set project_id = 1002, project_name = 'ミーティング'
 where toggl_entry_id in (
   'demo-toggl-2026-05-15-02',
   'demo-toggl-2026-05-17-02'
 );

update public.demo_toggl_time_entries
   set project_id = 1003, project_name = 'ドキュメント'
 where toggl_entry_id in (
   'demo-toggl-2026-05-15-04',
   'demo-toggl-2026-05-17-04'
 );

update public.demo_toggl_time_entries
   set project_id = 1004, project_name = '設計・思考'
 where toggl_entry_id in (
   'demo-toggl-2026-05-16-01',
   'demo-toggl-2026-05-17-05'
 );

update public.demo_toggl_time_entries
   set project_id = 1005, project_name = 'レビュー'
 where toggl_entry_id = 'demo-toggl-2026-05-16-03';
