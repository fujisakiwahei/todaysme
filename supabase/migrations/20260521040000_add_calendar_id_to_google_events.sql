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
--   - 既存行は calendar_id が不明なので削除する。MVP は単一ユーザー運用で、
--     `/api/summary/refresh` を 1 回叩けば直近 14 日ぶんは Google から再取得される。
--     ここで残すと legacy 行 (calendar_id 空) は新 conflict key にヒットせず
--     永久に `is_deleted=false` のまま重複として残ってしまうので、最初に消す。
--   - calendar_id text not null 列を追加。default は付けない (空テーブルなので不要)。
--   - unique 制約を (user_id, calendar_id, google_event_id) へ張り替え。
-- =============================================================================

delete from public.google_calendar_events;

alter table public.google_calendar_events
  add column calendar_id text not null;

alter table public.google_calendar_events
  drop constraint google_calendar_events_user_event_unique;

alter table public.google_calendar_events
  add constraint google_calendar_events_user_calendar_event_unique
    unique (user_id, calendar_id, google_event_id);
