-- =============================================================================
-- google_calendar_events.calendar_id 追加 (Issue #39 / PR #78 Codex review)
--
-- 背景:
--   Google Calendar の `event.id` はカレンダー内でユニークなだけで、複数の
--   カレンダーから同期するとカレンダーを跨いで同じ ID が衝突しうる
--   (例: 共有された繰り返しイベントが両方のカレンダーに出るケース)。
--   既存の `unique (user_id, google_event_id)` だと一方の row が他方を上書きし、
--   `calendar_name` / `start_at` / `end_at` が壊れる + 後段のソフトデリート判定が
--   狂う。
--
-- 対応:
--   - calendar_id text not null 列を追加。新規挿入は必須。
--   - unique 制約を (user_id, calendar_id, google_event_id) へ張り替え。
--   - MVP は単一ユーザー運用かつ refresh で全 row が上書きされるため、既存行は
--     一時的に空文字で埋めてから default を外す。Issue #39 マージ後に
--     `/api/summary/refresh` を一度叩けば実際の calendar_id で埋まる。
-- =============================================================================

alter table public.google_calendar_events
  add column calendar_id text not null default '';

alter table public.google_calendar_events
  alter column calendar_id drop default;

alter table public.google_calendar_events
  drop constraint google_calendar_events_user_event_unique;

alter table public.google_calendar_events
  add constraint google_calendar_events_user_calendar_event_unique
    unique (user_id, calendar_id, google_event_id);
