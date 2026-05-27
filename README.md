# Today's ME

Oura / Google Calendar / Toggl Track を統合し、「今日をどう使ったか」を 1 つの時間軸で可視化する個人向けダッシュボード。Nuxt 4 + Supabase + Vercel 構成、初期 MVP は単一ユーザー（開発者本人）運用前提。詳細仕様は [docs/SPEC.md](./docs/SPEC.md) を参照。

## セットアップ

Node のバージョンは `.nvmrc` で固定、パッケージマネージャは pnpm（Corepack 経由）を使う。

```bash
nvm use            # .nvmrc に従って Node を切替
corepack enable    # pnpm を有効化
pnpm install       # 依存関係をインストール
pnpm dev           # 開発サーバ起動（http://localhost:3000）
```

### Supabase ローカル起動

DB / Auth は Supabase を使う。ローカル開発時は Supabase CLI で起動する。

```bash
supabase start     # 初回は Docker イメージのダウンロードが走る
supabase stop      # 終了時
```

`supabase/migrations/` 配下の SQL がマイグレーションとして適用される（Issue #26）。

## 環境変数

`.env.example` をコピーして `.env` を作成し、各値を埋める。

```bash
cp .env.example .env
```

主な変数:

| 変数                                        | 用途                                                      |
| ------------------------------------------- | --------------------------------------------------------- |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY`        | Supabase 接続                                             |
| `TOKEN_ENCRYPTION_KEY`                      | 外部サービストークン暗号化キー（base64 encoded 32 bytes） |
| `OURA_CLIENT_ID` / `OURA_CLIENT_SECRET`     | Oura OAuth2                                               |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Calendar OAuth2                                    |
| `TOGGL_API_TOKEN`                           | Toggl Track API token                                     |
| `SENTRY_AUTH_TOKEN`                         | Sentry source map アップロード用                          |

詳細は `.env.example` を参照。

## スクリプト

| コマンド          | 用途                    |
| ----------------- | ----------------------- |
| `pnpm dev`        | 開発サーバ起動          |
| `pnpm build`      | 本番ビルド              |
| `pnpm preview`    | ビルド結果のプレビュー  |
| `pnpm typecheck`  | 型チェック              |
| `pnpm lint`       | ESLint                  |
| `pnpm lint:style` | Stylelint（SCSS / Vue） |
| `pnpm format`     | Prettier フォーマット   |

## ドキュメント

- [docs/SPEC.md](./docs/SPEC.md) — 確定版仕様書（コンセプト / API / DB / 認証 / アーキテクチャ）
