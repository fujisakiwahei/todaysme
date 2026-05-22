# State Management

このアプリの状態管理は **意図的に最小限**。Pinia は SPEC に書かれているが**現状導入していない**。  
ここでは「**何をどこに置くか / なぜ store を作っていないか**」を明示する。

---

## 状態のカテゴリ

| 種類 | 置き場所 | 例 |
| --- | --- | --- |
| **認証セッション** | Supabase SDK の内部状態 + cookie | `useSupabaseUser()` / `useSupabaseClient()` |
| **サマリーデータ（API 取得結果）** | ページコンポーネントの `ref` | `/daily/[date].vue` の `summary` |
| **連携状況** | `/settings` ページの `ref` | `connections` 配列 |
| **フォーム入力** | ページの `ref` | `togglToken` / `excludedDraft` |
| **UI 一時状態** | ページの `ref` | `loading` / `refreshing` / `errorMessage` |
| **「Wake-based today」の解決** | 関数呼び出しのローカル変数 | `fetchWakeBasedToday()` の戻り値 |
| **クロスページ共有状態** | **無い**（現状） | — |

---

## 何をどこに持つべきか

### 1. ローカル state（コンポーネント / ページの `ref`）

「**1 つのページだけが知っていれば足りる状態**」はすべてここ。

- `/daily/[date].vue` の `summary` / `loading` / `refreshing` / `errorMessage`。
- `/settings` の連携状況、トークン入力欄、除外カレンダー draft。

`ref` で十分。Vue の reactivity がそのまま使える。

### 2. SDK 提供の composable

Supabase の `useSupabaseUser` / `useSupabaseClient` は **SDK 内部のセッション** を reactive にラップしている。
- ページ間で「同じ user」が見えるのは SDK が cookie + メモリで保持しているから。
- アプリ側で別に user store を作る必要は無い（その分依存が減る）。

### 3. Server state（API 取得結果）

`$fetch` の戻り値を `ref` に入れているだけで、**SWR / TanStack Query 的なキャッシュは入れていない**。
- 日付遷移したら再フェッチ。
- 連続フェッチでレースが起きないよう `activeRequestId` 連番で「自分が最新でなければ書かない」防御を入れている。

### 4. Cross-page 共有

現状必要が無い。「`/settings` で接続したら `/daily/today` でも反映されてほしい」は、ページ遷移時に再フェッチで足りている。

---

## なぜ Pinia ストアが無いのか

`docs/SPEC.md` §8 には Pinia と書いてあるが、コード上は `nuxt.config.ts` の `modules` から除外している。

理由（`nuxt.config.ts` のコメント）:

> `@pinia/nuxt` は将来の状態管理用に SPEC に記載されているが、現状ストアが無いため一旦除外する。pinia v3.0.4 が SSR バンドル時に `dist/pinia.prod.cjs` を取り込み、Vue の ESM に default export が無いことで起動時 SyntaxError → 本番が全ルート 500 になる回避（Issue #99）。再導入時は `defineStore` を実際に使い始めるタイミングで合わせて検証する。

要点:
- ストアが本当に必要な状態が **現時点で無い**。
- 過去に Pinia 起因で本番が全ルート 500 になった事故がある（Issue #99）。
- 「**使う時に再導入して本番でも一度検証する**」が現方針。

---

## いつ Pinia（または別の store）を入れるべきか

以下のいずれかが満たされたら検討:

1. **複数ページが同じ state を読む / 書く**
   - 例: ヘッダの「現在のユーザー名 / アバター」を `/daily/*` と `/settings` で共有したい、など。
   - 単純な参照だけなら `useSupabaseUser` で足りる可能性が高い。

2. **API 取得のキャッシュが UX 上必要**
   - 日付ナビでクリックするたび 200-300ms 待たされるのが体験を損なう、など。
   - `useState`（Nuxt built-in）や TanStack Query で先に試す手もある。

3. **複雑なフォーム / wizard を跨ぐ state**
   - 現状 `/settings` で一画面に収まっている。

導入する時は **必ず**:
- Issue #99 を読む。
- Preview 環境で SSR バンドルが壊れていないか確認する。

---

## `useState` という選択肢

Nuxt が標準で提供する `useState` は SSR-safe な共有 ref。Pinia ほどの構造化は要らないが「ページ間で 1 つの値を共有したい」場合に手頃。

```ts
const today = useState<string>("wake-based-today", () => "");
```

Wake-based today の結果を `/daily/today.vue` から `/daily/[date].vue` に渡す手段として現在は使っていないが、将来「全画面共通のヘッダにストリーキング表示を出したい」等の要求が出たら `useState` から検討する。

---

## レース対策パターン（参考）

`/daily/[date].vue` で実装している「stale レスポンス棄却」は store を入れる前の最終手段として読みやすい:

```ts
let activeRequestId = 0;

async function fetchSummaryCore(reqId: number) {
  const res = await $fetch<SummaryResponse>("/api/summary", { query: { date } });
  if (reqId !== activeRequestId) return; // 古いリクエストの結果は捨てる
  summary.value = res;
}

async function fetchSummary() {
  const reqId = ++activeRequestId;
  // ...
}
```

これで「連続して日付ナビをクリック → 古いレスポンスで新しい日付の画面を上書き」を防いでいる。Store を入れずに済むパターンの典型。

---

## 状態の境界（責務）

| 状態 | 持つ責務 |
| --- | --- |
| `useSupabaseUser` | 「ログインしているか」「user.id は何か」だけ |
| ページの `summary ref` | 「いま画面に表示しているデータ」 |
| ページの `errorMessage` | 「ユーザーに見せたいエラーメッセージ」 |
| `daily_sync_statuses`（DB） | 「最後にいつ同期されたか / 同期中か」 — UI はここを source of truth として読む |

「同期中かどうか」を UI 側の `ref` だけで持つと、別タブから refresh された時に detect できない。`daily_sync_statuses` を DB の source of truth として `/api/summary` のレスポンスに含めることで、UI は **取得時の状態** を表示できる（厳密にはポーリングは入れていないので、最新ではないが「30 分以内なら stale 判定で裏で再取得する」で十分な精度を保っている）。

---

## 変更時の注意点

- 新しい store / `useState` を入れる時は、**ページの `ref` で足りないかを先に確認** する。
- Pinia を導入する場合は Issue #99 / SSR バンドル検証を必ず通す。
- ログイン情報の **独自型は作らない**（Google OAuth に一任 / Issue #54）。`User` 型は `@supabase/supabase-js` のものをそのまま使う。

---

## 次に読むもの

- [data-flow.md](./data-flow.md) — どの state がいつ更新されるか
- [ui.md](./ui.md) — コンポーネント構成
