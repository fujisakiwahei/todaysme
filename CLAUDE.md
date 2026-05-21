# CLAUDE.md

このファイルは Claude Code（および他の AI コーディングエージェント）がこのリポジトリで作業する際の前提情報を集約したもの。実装前に必ず読むこと。

## プロジェクト概要

**Today's ME** は Oura / Google Calendar / Toggl Track を統合し、「今日をどう使ったか」を 1 つの時間軸で可視化する個人向けダッシュボード。  
Nuxt 4 (SSR) + Supabase (PostgreSQL + Auth) + Vercel 構成。MVP は単一ユーザー（開発者本人）運用前提。  
詳細は [`docs/SPEC.md`](./docs/SPEC.md) を参照。

## 参照優先順位

矛盾が出た場合は上が正。

1. **コードベース**（実装が事実）
2. **`docs/SPEC.md`**（確定版仕様書）
3. **`docs/spec-rough.md`**（過去ラフ・参考）
4. **GitHub Issue**（個別タスクの背景）

## ディレクトリ規約

| パス | 役割 |
| --- | --- |
| `app/` | Nuxt 4 の app ディレクトリ（`app.vue` / `pages/` / `components/` / `layouts/` / `assets/`） |
| `app/pages/` | ルーティング（`/` / `/demo` / `/daily/[date]` / `/settings` 等） |
| `app/components/` | Vue コンポーネント |
| `app/assets/styles/` | SCSS（`design-tokens.scss` / `variables.scss` / `mixins.scss` / `reset.scss` / `style.scss`） |
| `server/api/` | Nuxt server routes（`/api/summary`, `/api/summary/refresh`, `/api/cron/daily` など） |
| `server/utils/` | Oura / Google / Toggl の API クライアント等の内部モジュール。サービス別 HTTP エンドポイントは公開しない |
| `shared/schemas/` | Zod スキーマ（API リクエスト/レスポンス、外部 API レスポンス検証用） |
| `supabase/migrations/` | Supabase の SQL マイグレーション（GUI で変更後ここにコミット） |
| `docs/` | 仕様書類。`docs/personal/` は個人メモ（git 追跡対象外） |
| `desine-tone/` | デザインの基準ファイル群。UI 実装時はここの内容をベースにする |

## コマンド一覧

| コマンド | 用途 |
| --- | --- |
| `pnpm dev` | 開発サーバ起動（http://localhost:3000） |
| `pnpm build` | 本番ビルド |
| `pnpm preview` | ビルド結果のプレビュー |
| `pnpm typecheck` | 型チェック（`nuxi typecheck`） |
| `pnpm lint` | ESLint |
| `pnpm lint:style` | Stylelint（SCSS / Vue） |
| `pnpm format` | Prettier フォーマット |
| `pnpm sass` | SCSS のコンパイル（UI 実装後・テスト前に必ず実行） |
| `supabase start` / `supabase stop` | ローカル Supabase 起動・停止 |

## 実装時の必須ルール

### UI 実装時
- **デザインは `desine-tone/` ディレクトリの内容をベースにする**。独自にトーンを作らない。
- 実装後、**テスト前に SCSS のコンパイル（`pnpm sass`）を必ず実行**する。
- UI を実装したら、**Playwright MCP（ブラウザ操作）で必ず動作確認**する。テストファイルは書かない（後述「テストファイル」を参照）。実行できない場合（環境依存・ローカル Supabase 未起動など）は、勝手に省略せずユーザーに確認する。

### コード規約
- TypeScript strict。
- API のリクエスト / レスポンスは **Zod でスキーマ検証**（仕様 §12.3）。
- 外部サービストークンは **AES-256-GCM で暗号化**して `service_connections` に保存。**クライアントに返さない / ログに出さない**（仕様 §12.1）。
- 全 user 紐づきテーブルで **RLS を有効化**（`auth.uid()` で行制限）。
- SCSS は `app/assets/styles/variables` と `mixins` が `additionalData` で全 SCSS に自動 inject される（`nuxt.config.ts`）。各ファイルで `@use` する必要はない。

### テストファイル
- **ユーザーから明示的な指示がない限り、テストファイル（`*.test.ts` / `*.spec.ts` などユニット / e2e テスト用のファイル）を生成しない**。開発段階での予期せぬエラーを防ぐため（Issue #63）。
- UI の動作確認は Playwright MCP（ブラウザ操作）で都度行う。Playwright のテストファイル（`tests/` 配下や `*.spec.ts`）も同様に明示指示がない限り作らない。

### Git / PR
- `main` への直接 push は不可（保護ブランチ）。feature branch → PR → Vercel Preview で確認 → マージ。
- pre-commit で `lint-staged`（`eslint --fix` + `prettier --write`）が走る。
- CI（`.github/workflows/ci-check.yml`）で `pnpm lint` / `pnpm nuxi typecheck` / `pnpm build` が実行される。

### Zod スキーマ（`shared/schemas/`）
- 配置: `shared/schemas/` 直下にサービス / 用途別ファイル（`common.ts` / `errors.ts` / `summary.ts` / `oura.ts` / `google.ts` / `toggl.ts`）。利用側は barrel の `shared/schemas/index.ts` から import する。
- 命名規約: スキーマ実体は `<対象>Schema`（例: `summaryRequestSchema`）。`z.infer` した型は `<対象>` をそのまま PascalCase で（例: `SummaryRequest`）。
- export 方針: スキーマと推論型を **必ずペアで named export**。default export は禁止。`shared/schemas/index.ts` から `export *` で再公開する。
- 重複定義の禁止: `provider` / `source` / `status` / `target_date` 等 DB 制約と対応する enum は `common.ts` に一度だけ定義し、他ファイルからは import して再利用する。
- 検証は **`server/utils/validation.ts` の `parseOrThrow` / `parseExternal`** を経由する（直接 `.parse()` を呼ばない）。`parseExternal` は失敗時に 502 を投げ、サービス名を `statusMessage` に乗せる。
- ログイン情報の型は定義しない（Google OAuth に一任。Issue #54）。

## 環境変数

`.env.example` をコピーして `.env` を作成する（`cp .env.example .env`）。

| 変数 | 用途 |
| --- | --- |
| `NUXT_PUBLIC_SUPABASE_URL` | Supabase プロジェクト URL（クライアント / サーバ両方で参照） |
| `NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key（旧 `anon` key 相当。クライアント側で使用） |
| `SUPABASE_SECRET_KEY` | Supabase secret key（旧 `service_role` key 相当。RLS バイパス。server 側のみ・Cron 等で使用） |
| `TOKEN_ENCRYPTION_KEY` | 外部サービストークン暗号化キー（base64 encoded 32 bytes）。DB には置かない |
| `OURA_CLIENT_ID` / `OURA_CLIENT_SECRET` | Oura OAuth2 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Calendar OAuth2 |
| `TOGGL_API_TOKEN` | Toggl Track API token（個人用 MVP のみ） |
| `SENTRY_AUTH_TOKEN` | Sentry source map アップロード用（`.env.sentry-build-plugin` に格納） |

## 主要な仕様メモ（実装時に間違えやすい点）

- **Wake-based Timeline**: 1 日は `00:00–24:00` ではなく「**前回起床〜現在 / 次回睡眠**」で扱う。
- **`target_date`**: Oura 睡眠データは **起床日**（ユーザータイムゾーンで `wake_at` の日付）に紐づける。睡眠開始日ではない（Issue #24）。
- **タイムライン取得**: `target_date` 完全一致ではなく、**wake range と `start_at`/`end_at` の重なり**で読み込む。
- **同期トリガー**: 当日のみ 30 分ステイルでバックグラウンド更新。過去日は手動ボタンのみ。Cron は直近 14 日（毎朝 05:00）。
- **同期は部分失敗を許容**（仕様 §9.2）。サービス別に `daily_sync_statuses` を更新。
- **削除はソフトデリート**（`is_deleted = true`）。
- **デモは本番テーブルと分離**（`demo_*` テーブル群）。

## AI 開発フロー

```
Issue → docs/SPEC.md と関連 Issue を読む → Plan → feature branch
  → 実装 → pnpm lint / typecheck → pnpm sass → Playwright で動作確認
  → PR → Vercel Preview で確認 → Merge
```
