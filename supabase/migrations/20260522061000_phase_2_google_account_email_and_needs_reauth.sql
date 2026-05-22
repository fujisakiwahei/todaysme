-- =============================================================================
-- 複数 Google アカウント連携 Phase 2 (Issue #131 / 設計ドラフト
-- docs/designs/multi-google-account.md §4.1 / §4.2 / §6)
--
-- 目的:
--   1. service_connections に account_email 列 (NULL 許容) を追加。Phase 2 で
--      OAuth callback が id_token を JWKS 検証し、userinfo.email として
--      取り出した値を保存する。設定 UI に「どのアカウントか」を識別表示する
--      ためだけに使う (Issue #131 決定: account_label の手入力 UI は出さない /
--      email を自動表示のみ)。
--   2. status enum に 'needs_reauth' を追加。これは Phase 2 移行に伴う
--      過渡的な状態で、「既存接続だが provider_user_id (sub) を取り直すため
--      ユーザーに再認可を促す必要がある」ことを示す。settings 画面で
--      バナーとして表示する。
--   3. 既存の Google 接続行 (provider_user_id IS NULL のもの) を
--      status='needs_reauth' に更新し、sync 系から ServiceNotConnectedError で
--      止まるようにする。再認可フローを踏むことで provider_user_id と
--      account_email が backfill され、自動的に status='connected' に戻る。
--
-- 順序の制約 (設計 §4.2 / §6):
--   - 本マイグレーションは Phase 1a の partial unique index が張ってあることを
--     前提とする (= 20260522060000 が先に適用済み)。Phase 1a の index は
--     「sub 未取得の Google 行が複数存在しない」ことを保証する保険なので、
--     本マイグレーションで status を 'needs_reauth' に落とす際にも有効な
--     ガードとして残しておく。
--   - 本マイグレーションの後、人 (= 開発者) が UI 上で再認可を踏むことで
--     既存行の provider_user_id / account_email が埋まる。その完了確認
--     (SELECT count(*) WHERE provider='google' AND provider_user_id IS NULL = 0)
--     を取った上でのみ Phase 1b 移行を流す。
-- =============================================================================

-- 1. account_email 列を追加 (NULL 許容)。
alter table public.service_connections
  add column account_email text;

-- 2. status の CHECK 制約に 'needs_reauth' を追加。
--    drop → re-add で値集合を 4 値に拡張する。
alter table public.service_connections
  drop constraint service_connections_status_check;

alter table public.service_connections
  add constraint service_connections_status_check
    check (status in ('connected', 'disconnected', 'error', 'needs_reauth'));

-- 3. 既存の Google 接続行 (sub 未取得) を 'needs_reauth' に落とす。
--    既に disconnected / error の行は触らない (ユーザーが意図して切断したり
--    refresh 失敗で error に落ちているケースを、再認可必要状態で上書きしない)。
update public.service_connections
set
  status = 'needs_reauth',
  updated_at = now()
where provider = 'google'
  and provider_user_id is null
  and status = 'connected';
