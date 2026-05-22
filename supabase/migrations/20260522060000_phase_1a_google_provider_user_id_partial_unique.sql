-- =============================================================================
-- 複数 Google アカウント連携 Phase 1a (Issue #131 / 設計ドラフト
-- docs/designs/multi-google-account.md §6)
--
-- 背景:
--   Phase 0 (PR #127) で確定した「複数 Google アカウント連携」設計の
--   Phase 1a。実装フェーズの最初の DB マイグレーション。
--
--   Phase 1a の目的は、以降の Phase 2 (OAuth callback で id_token を JWKS 検証
--   して provider_user_id を backfill) と並行運用するための "保険" を張ること。
--   既存の unique(user_id, provider) constraint は維持し、再認可フローが
--   走っている最中でも「provider_user_id が NULL のままの Google 行」が
--   複数できないよう、過渡期用の partial unique index を 1 本追加する。
--
-- 状況:
--   - public.service_connections.provider_user_id 列は
--     20260517160100_create_production_tables.sql で既に NULL 許容で存在
--     しているため、ALTER TABLE は不要。
--   - unique(user_id, provider) constraint (service_connections_user_provider_unique)
--     は本マイグレーションでは触らない。Phase 1b でまとめて drop する。
--
-- 本マイグレーションでやること:
--   - service_connections_google_legacy_unique という partial unique index を作成。
--     条件: provider = 'google' AND provider_user_id IS NULL。
--     これにより「sub 未取得の Google 行は最大 1 件」を物理的に保証する。
--
-- 順序の制約 (設計 §4.2 / §6 参照):
--   Phase 1a → Phase 2 (sub backfill) → Phase 1b (旧 unique drop + 本番用
--   partial unique index 2 本作成) の順を厳守。NULL 持ち旧行を残したまま
--   3 列 unique を張ると、PostgreSQL の合成 unique が NULL を distinct と
--   見なすため、provider_user_id が NULL の旧行と sub を持つ新行が同じ
--   user × provider で共存できてしまう (Codex review #127 P1)。
-- =============================================================================

create unique index if not exists service_connections_google_legacy_unique
  on public.service_connections (user_id, provider)
  where provider = 'google' and provider_user_id is null;
