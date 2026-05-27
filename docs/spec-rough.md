# Today's ME 仕様書

## 概要

Today's ME は、Oura / Google Calendar / Toggl Track を統合し、「今日をどう使ったか」を可視化する個人向けダッシュボードアプリ。
単なるカレンダーや作業記録ではなく、

- 今日やること
- 今日やったこと
- 今日の身体状態
  を、1つの時間軸で統合表示することを目的とする。

---

# コンセプト

## Today's ME

今日の状態を一目で把握するダッシュボード。

## Wake-based Timeline

Today's ME では、1日を 00:00〜24:00 ではなく、

- 前回起床
- 次回睡眠
  までとして扱う。

---

# 目的

- フルスタックアプリ開発経験
- モダンWebアプリ構成の実践
- 外部API統合
- 認証 / DB / API / 可視化 / デプロイ経験
- ポートフォリオ公開
- 自分用実運用

---

# 使用サービス

## Oura

- 睡眠
- readiness
- 活動量
  取得元：
- Oura API v2

## Google Calendar

- 今日の予定
- カレンダー別予定時間

## Toggl Track

- 今日やったこと
- 作業時間

---

# 中核UI

## 1. Today's ME

日次サマリー表示。

### 表示項目

#### Oura

- 睡眠時間
- 睡眠スコア
- readiness
- 起床時刻
- active calories

#### Google Calendar

- 今日の予定時間
- カレンダー別予定時間
- 会議時間

#### Toggl Track

- 今日の作業時間
- タイトル別作業時間

#### 独自集計

- 起床から現在までの経過時間
- アクティブ時間割合
- 未記録時間

## 2. Wake-based Timeline

Oura / Google Calendar / Toggl Track を統合したタイムライン。

### レーン

#### Sleep

Oura 睡眠。

#### Calendar

Google Calendar 予定。

#### Work

## Toggl Track 作業ログ。

# 1日の定義

## 当日

前回起床時刻〜現在時刻。

## 過去日

## 前回起床時刻〜次回睡眠開始時刻。

# ページ構成

## 公開ページ

### `/`

トップページ。

### `/demo`

公開デモ。

### `/demo/daily/[date]`

デモ用日次詳細ページ。

## 認証必須ページ

### `/app`

`/daily/today` にリダイレクト。

### `/daily/[date]`

日次詳細ページ。
例：

- `/daily/2026-01-01`
- `/daily/today`
  表示内容：
- Today's ME
- Wake-based Timeline
- Oura 情報
- Google Calendar 予定
- Toggl Track 作業ログ

### `/settings`

## 外部サービス連携設定。

# 認証

## Supabase Auth

利用方式：

- Googleログイン
- メールアドレスログイン

---

# API構成

## `/api/oura`

Oura データ取得・整形。

## `/api/google`

Google Calendar データ取得・整形。

## `/api/toggl`

Toggl Track データ取得・整形。

## `/api/summary`

Today's ME / Wake-based Timeline 用の統合データ生成。

## `POST /api/summary/refresh`

対象日のデータを再取得・再同期する。
役割：

- Oura API 呼び出し
- Google Calendar API 呼び出し
- Toggl API 呼び出し
- DB保存
- summary再計算

---

# データ取得方針

## 基本方針

外部APIを毎回直接参照せず、取得済みデータをDBに保存する。

## 手動更新

`/daily/[date]` の更新ボタン押下時：
`txt
POST /api/summary/refresh
`
を実行。
対象日のデータを再取得する。

## 自動同期

毎日午前5時に自動同期を実行する。
対象：

- 直近14日分
  内容：
- Oura
- Google Calendar
- Toggl Track
  を再取得する。

## 15日以前

15日以前のデータは自動同期しない。
対象日のページを開き、手動更新した時のみ再取得する。

---

# DB保存方針

## 基本

取得データはDBに保存する。

## 更新方式

external_id をキーに upsert。

### Google Calendar

- google_event_id

### Toggl Track

- toggl_entry_id

### Oura

- oura_sleep_id
- または対象日

## 削除対応

物理削除は行わない。

### 方針

同期時に取得できなかった既存データは：
`txt
is_deleted = true
`
とする。

## summary再計算

## 同期完了後、対象日の summary を再計算する。

# Google Calendar分類

カレンダー単位で分類する。
例：

- パーソナル
- MTG
- 勉強・思考
- 学習
- 予定ブロック

---

# Toggl Track分類

タイトル単位で扱う。
ただし：

- 別プロジェクト
- 別ID
  は別データとして扱う。

---

# タイムゾーン

## ユーザー設定。

# API失敗時

失敗したサービス名とエラー内容を返却する。
例：
`json
{
  "errors": [
    {
      "service": "google",
      "message": "token expired"
    }
  ]
}
`

---

# Demoモード

## 方針

一般公開SaaSではなく、

- 自分用実運用
- 公開デモ
  を分離する。

## Demo

- ログイン不要
- DB保存済みサンプルデータ使用
- 外部API不要

---

# インフラ構成

## Frontend / API

- Nuxt 4
- Vercel

## Database / Auth

- Supabase
- PostgreSQL
- Supabase Auth

## Cron

- Vercel Cron
  毎朝5時に：
  `txt
POST /api/summary/refresh
`
  を実行。

---

# Cloudflare

Cloudflare Proxy は利用しない。
必要に応じて DNS 管理のみ利用する。

---

# 初期MVP

## 実装対象

- `/demo`
- `/daily/[date]`
- Today's ME
- Wake-based Timeline
- Oura連携
- Google Calendar連携
- Toggl連携
- DB保存
- 手動同期
- 毎朝5時の自動同期

---

# 初期は実装しないもの

- AIチャット
- SNS機能
- チーム共有
- 通知
- 自動分析
- 週間 / 月間分析
- モバイルアプリ
- リアルタイム同期
- SaaS公開
