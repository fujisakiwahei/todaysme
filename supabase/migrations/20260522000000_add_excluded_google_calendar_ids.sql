-- =============================================================================
-- public.users.excluded_google_calendar_ids 追加 (Issue #108)
--
-- 背景:
--   ユーザーによっては「予定ブロック / Deep Work 枠」用に専用カレンダーを
--   持っており、それを稼働時間 (todays_me.google.total_minutes /
--   meeting_minutes / by_calendar) の合計に含めると実際より大幅に長く出る。
--
-- 対応:
--   - users に除外カレンダーの ID 配列 (Google calendarId) を持たせる。
--   - 除外イベントはタイムラインには出すが、稼働時間集計からは除く
--     (UI 側で薄く表示する目印に is_excluded を summary レスポンスに乗せる)。
--   - MVP は単一ユーザー運用なので別テーブルにせず users にぶら下げる。
--     複数ユーザー化時は user_settings 等に切り出す想定。
-- =============================================================================

alter table public.users
  add column excluded_google_calendar_ids text[] not null default '{}';
