# Environment

ローカル開発と本番 / Preview デプロイで使う環境変数と、それらが **どこから読まれてどの責務を担うか** を整理する。

> 値の正は **Vercel Project Settings** と `.env.example`（ローカル用テンプレ）。

---

## 環境変数一覧

| 変数                                        | スコープ        | 用途                                                                 | どこで使う                                                           |
| ------------------------------------------- | --------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `NUXT_PUBLIC_SUPABASE_URL`                  | public          | Supabase プロジェクト URL                                            | クライアント / サーバ両方（`@nuxtjs/supabase` / `getSupabaseAdmin`） |
| `NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`      | public          | 旧 `anon` key 相当。RLS が効く                                       | クライアント側で SDK 初期化                                          |
| `SUPABASE_SECRET_KEY`                       | **server only** | 旧 `service_role` key 相当。**RLS を bypass**                        | `getSupabaseAdmin()` 経由でのみ                                      |
| `TOKEN_ENCRYPTION_KEY`                      | **server only** | 外部サービストークン暗号化キー（base64 32 bytes）                    | `server/utils/crypto.ts`                                             |
| `OAUTH_STATE_SECRET`                        | **server only** | OAuth state の HMAC 鍵（未設定なら `TOKEN_ENCRYPTION_KEY` から派生） | `server/utils/oauthState.ts`                                         |
| `OURA_CLIENT_ID` / `OURA_CLIENT_SECRET`     | server only     | Oura OAuth2                                                          | `server/utils/oauth/oura.ts`                                         |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | server only     | Google Calendar OAuth2                                               | `server/utils/oauth/google.ts`                                       |
| `TOGGL_API_TOKEN`                           | server only     | Toggl Track API token（個人用 MVP 向け fallback）                    | `server/utils/getTogglData.ts` 等                                    |
| `CRON_SECRET`                               | server only     | Vercel Cron 認証用                                                   | `server/api/cron/daily.get.ts:authorizeCron`                         |
| `SENTRY_AUTH_TOKEN`                         | server only     | Sentry source map upload                                             | ビルド時のみ（`.env.sentry-build-plugin` 経由が推奨）                |

---

## public / server only の分け方

| プレフィックス  | 露出範囲                                           |
| --------------- | -------------------------------------------------- |
| `NUXT_PUBLIC_*` | **クライアント JS にも入る**。秘密にしてはいけない |
| それ以外        | サーバプロセスのみ。クライアントに露出しない       |

**理由**: Nuxt の `runtimeConfig.public` に入る値（= `NUXT_PUBLIC_*`）はクライアントバンドルにインライン化される。secret を入れたら全世界に公開されることになる。

```ts
// nuxt.config.ts
runtimeConfig: {
  public: {
    supabaseUrl: process.env.NUXT_PUBLIC_SUPABASE_URL,
    supabasePublishableKey: process.env.NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  },
},
```

---

## 鍵 / シークレットの管理

### `TOKEN_ENCRYPTION_KEY`

- **base64 encoded 32 bytes**。AES-256-GCM の対称鍵。
- 生成例: `openssl rand -base64 32`。
- 失うと **すべての暗号化済みトークンを復号できなくなる**。一度発行したら絶対に消さない / 共有しない。
- DB には絶対に置かない（Vercel env のみ）。

### `OAUTH_STATE_SECRET`

- 任意の文字列。OAuth state の HMAC-SHA256 署名鍵。
- 未設定なら `TOKEN_ENCRYPTION_KEY` から `todaysme:oauth-state:v1` ラベルで派生（鍵分離）。
- 明示的に分ける場合は、TOKEN_ENCRYPTION_KEY とは違う値を入れる。

### `SUPABASE_SECRET_KEY`

- RLS を bypass する強力なキー。**サーバ側でのみ** 使う。
- 漏れたら任意ユーザーの行が読める / 書ける。

### `CRON_SECRET`

- Vercel が Cron 起動時に `Authorization: Bearer ${CRON_SECRET}` を付ける。
- アプリ側が一致しないと 401。
- **未設定なら 503**（公開エンドポイントとして誤って叩かれないため）。

---

## ローカル開発のセットアップ

```bash
# 0. 依存をセットアップ
corepack enable
pnpm install

# 1. .env を作る
cp .env.example .env

# 2. .env の各値を埋める
#    - Supabase: 自分のプロジェクトの URL / Publishable Key / Secret Key
#    - TOKEN_ENCRYPTION_KEY: openssl rand -base64 32
#    - Oura / Google / Toggl: 各サービスのデベロッパーポータルで発行

# 3. （必要なら）ローカル Supabase を起動
supabase start

# 4. 開発サーバ
pnpm dev          # http://localhost:3000
```

### Supabase のローカル / リモートの使い分け

- ローカル Supabase: `supabase start` で起動。RLS の検証や migration の試行に便利。
- リモート（クラウド Supabase）: 本番に近い環境で試したい時。`.env` の URL / key を本物に差し替えるだけ。

> **注意**: リモート Supabase を `.env` に書く時、本番ユーザーのデータに触れないよう **dev / staging プロジェクト** を分けて使う。

---

## OAuth プロバイダ側の設定

各サービスのデベロッパーポータルで:

- **Oura**: redirect URI に `http://localhost:3000/api/connections/oura/callback` と Vercel Preview / Production の URL を登録。
- **Google Cloud Console**:
  - OAuth client（Web application）を作る。
  - 「承認済みリダイレクト URI」に `http://localhost:3000/api/connections/google/callback` + Preview / Production の callback URL を登録。
  - スコープ: `calendar.events.readonly` + `calendar.calendarlist.readonly`。
- **Toggl**: Profile 画面で API token を発行（OAuth ではない）。

---

## Vercel での環境変数

Vercel Project Settings → Environment Variables。スコープを **Production / Preview / Development** で分けられる。

- secret 系（`*_SECRET_KEY` / `*_CLIENT_SECRET` / `TOKEN_ENCRYPTION_KEY` / `CRON_SECRET` / `OAUTH_STATE_SECRET`）は **必ず secret** として登録。
- public 系（`NUXT_PUBLIC_*`）は public 扱い（クライアントに露出する前提）。
- 新しい変数を入れたら redeploy が必要（環境変数は build 時にスナップショットされるため）。

---

## SCSS と環境変数

`nuxt.config.ts` の `vite.css.preprocessorOptions.scss.additionalData` で `variables` / `mixins` を全 SCSS に自動 prepend している。各 SCSS / .vue に `@use` を書く必要は無い。

---

## 環境変数を追加する手順

1. **意味と扱いを決める**:
   - public か server-only か。
   - secret なら漏洩時の影響範囲。
2. **`.env.example` に行を追加**（コメントで責務を一言）。
3. **`CLAUDE.md` の「環境変数」表を更新**。
4. **このオンボーディングの表を更新**。
5. **Vercel Project Settings に追加**（Production / Preview / Development それぞれ）。
6. 使う側のコードで `process.env.<KEY>` を読む際は **存在チェックして失敗時 throw**（`server/utils/crypto.ts:loadKey()` のように）。

---

## ありがちなトラブル

| 症状                                               | 原因                                                  | 対処                                       |
| -------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| `TOKEN_ENCRYPTION_KEY is not set`                  | `.env` に未設定 / base64 デコード後が 32 bytes でない | `openssl rand -base64 32` で生成           |
| `CRON_SECRET is not configured` で 503             | Cron 用シークレット未設定                             | Vercel env に登録                          |
| `GOOGLE_CLIENT_ID is not set`                      | OAuth 起動時に env 不足                               | dev portal で発行                          |
| Vercel Preview で OAuth が `redirect_uri_mismatch` | Google Cloud Console に Preview URL が未登録          | Preview の callback URL を Google 側に追加 |
| `SUPABASE_SECRET_KEY is not set` で 500            | server / cron で admin client を呼ぶ前に env が無い   | Vercel env に登録                          |
| クライアントで `import.meta.env.VITE_*` を使った   | Nuxt + Vercel + Vite では `NUXT_PUBLIC_*` を使う      | `NUXT_PUBLIC_<NAME>` に rename             |

---

## 次に読むもの

- [auth.md](./auth.md) — トークンの暗号化と OAuth state の鍵分離
- [deployment.md](./deployment.md) — Vercel / Sentry の構成
