// =============================================================================
// GET /api/cron/daily
// SPEC §9.1 / §10.2 / §10.3 / §10.4 / Issue #40
//
//   - Vercel Cron 専用 (vercel.json で 0 20 * * * UTC = 05:00 JST に登録)。
//   - `Authorization: Bearer ${CRON_SECRET}` のみ許可する。Vercel Cron は
//     プロジェクト環境変数 CRON_SECRET をこの形式で自動付与する。
//     CRON_SECRET 未設定や不一致は 401/503 で拒否し、公開エンドポイントとして
//     誤って叩かれないようにする。
//   - MVP の対象は users テーブル全件 × 直近 14 日 (today を含む)。15 日以前
//     は仕様により対象外 (手動更新でのみ再取得)。
//   - 各 (user, date, provider) ごとに `refreshUserDate` (POST /api/summary/refresh
//     と同じ共通ロジック) を呼ぶ。失敗は daily_sync_statuses に記録され、
//     ループ全体は止めない (部分失敗を許容)。
//   - 平文トークンや個別エラー詳細はレスポンスに含めない (ログ流出回避)。
//     失敗件数の集計だけ返し、詳細は daily_sync_statuses を参照する設計。
// =============================================================================
import type { H3Event } from "h3";
import { createError, getRequestHeader } from "h3";

import type { ServiceProvider } from "../../../shared/schemas";
import { PURGE_TARGETS, purgeSoftDeleted, type PurgeResult } from "../../utils/purgeSoftDeleted";
import { loadConnectedProviders, refreshUserDate } from "../../utils/runRefresh";
import { getSupabaseAdmin } from "../../utils/supabaseAdmin";

// 直近 14 日 (today を含む) を対象にする (SPEC §10.4)。
const REFRESH_DAYS = 14;

const BEARER_PREFIX = "Bearer ";

function authorizeCron(event: H3Event): void {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // 環境変数が未設定 = 設定不備。誰でも叩ける状態を防ぐため必ず拒否する。
    throw createError({
      statusCode: 503,
      statusMessage: "CRON_SECRET is not configured",
    });
  }
  const header = getRequestHeader(event, "authorization");
  if (
    !header ||
    !header.startsWith(BEARER_PREFIX) ||
    header.slice(BEARER_PREFIX.length).trim() !== expected
  ) {
    throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
  }
}

const FALLBACK_TIMEZONE = "Asia/Tokyo";

// users.timezone が無効な IANA 識別子 (null や typo) の場合に Asia/Tokyo に
// 寄せる。ここで sanitize した値を todayInTimezone / refreshUserDate の両方に
// 渡すことで、downstream (targetDateOf 等) でも同じ Intl.DateTimeFormat の
// RangeError を踏まないようにする。1 user の bad row でバッチ全体が止まらない
// 設計 (SPEC §9.2 部分失敗許容)。
function resolveTimezone(timezone: string | null): string {
  const candidate = timezone ?? FALLBACK_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

// timezone 内の "今日" を YYYY-MM-DD で返す。
// `Intl.DateTimeFormat("en-CA").format()` の出力は ICU データ依存で必ずしも
// ISO 形式 (YYYY-MM-DD) を保証しないため、formatToParts で year/month/day を
// 取り出して決定論的に組み立てる。timezone は resolveTimezone で検証済みの前提。
function todayInTimezone(timezone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// "YYYY-MM-DD" を UTC として解釈し、days 日ぶんずらして "YYYY-MM-DD" で返す。
// 日付演算は UTC 固定でやることで DST / TZ の影響を受けない。
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface UserRow {
  id: string;
  timezone: string | null;
}

export default defineEventHandler(async (event) => {
  authorizeCron(event);

  const admin = getSupabaseAdmin();

  // MVP は単一ユーザー前提だが、users テーブルから引いて汎用化しておく。
  const { data: users, error: usersErr } = await admin.from("users").select("id, timezone");
  if (usersErr) {
    throw createError({
      statusCode: 500,
      statusMessage: `failed to list users: ${usersErr.message}`,
    });
  }

  const startedAt = new Date();
  let usersProcessed = 0;
  let datesProcessed = 0;
  let errorCount = 0;

  for (const user of (users ?? []) as UserRow[]) {
    // user ごとの timezone / connections は 14 日ぶん共通なので 1 回だけ取る。
    // users.timezone は NOT NULL DEFAULT 'Asia/Tokyo' だが、想定外の値が混ざる
    // ケースに備えて resolveTimezone で sanitize する。sanitize 済みの値を
    // todayInTimezone と refreshUserDate の双方に渡すことで、cron 全体が
    // 一貫して有効な IANA timezone で動く。
    const timezone = resolveTimezone(user.timezone);
    let connected: Set<ServiceProvider>;
    try {
      connected = await loadConnectedProviders(user.id);
    } catch {
      // user 単位の準備に失敗したらこの user はスキップ (他 user の sync は続行)。
      errorCount += 1;
      continue;
    }

    // 連携サービスが無ければ refresh しても何もすることがない。
    if (connected.size === 0) {
      usersProcessed += 1;
      continue;
    }

    const today = todayInTimezone(timezone, startedAt);
    // 0..REFRESH_DAYS-1 = today, today-1, ..., today-13 (計 14 日)。
    // Issue #176: refreshUserDate は内部で service_connections を 1 回ずつ
    // 取り直す (token 失効・rotate を跨いだ stale snapshot 回避)。日付ループ間で
    // snapshot を共有しないため、`connected` を渡す option は廃止。
    for (let i = 0; i < REFRESH_DAYS; i += 1) {
      const date = shiftDate(today, -i);
      try {
        const result = await refreshUserDate(user.id, date, {
          timezone,
        });
        if (result.errors.length > 0) errorCount += result.errors.length;
      } catch {
        // refreshUserDate は通常自身で吸収するが、想定外で throw した場合に備える。
        errorCount += 1;
      }
      datesProcessed += 1;
    }
    usersProcessed += 1;
  }

  // 全 user の sync が一通り終わってから soft-delete purge を回す (Issue #150)。
  // sync 中に新規に立った is_deleted=true は updated_at が直近なので拾われない。
  // テーブル単位の失敗は purgeSoftDeleted 側で握り潰すので sync 結果は壊さない。
  let purgeResults: PurgeResult[] = [];
  let purgeErrorCount = 0;
  try {
    purgeResults = await purgeSoftDeleted(startedAt);
    purgeErrorCount = purgeResults.filter((r) => r.error !== null).length;
  } catch (e) {
    // purgeSoftDeleted は通常自身で吸収するが、想定外 throw 時はすべてのテーブルが
    // 実行されていないので、全件 fail 扱いで error_count に計上する。0 のままだと
    // 運用上の失敗が cron レスポンスから検知できなくなる。
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[cron/daily] purgeSoftDeleted threw unexpectedly: ${message}`);
    purgeResults = [];
    purgeErrorCount = PURGE_TARGETS.length;
  }

  return {
    processed_at: startedAt.toISOString(),
    users_processed: usersProcessed,
    dates_processed: datesProcessed,
    days_per_user: REFRESH_DAYS,
    error_count: errorCount,
    purge: {
      // 個別エラー詳細はレスポンスに乗せない (cron 既存方針: ログ流出回避)。
      // 詳細は Vercel ログ側で console.error を確認する。
      results: purgeResults.map((r) => ({
        table: r.table,
        deleted: r.deleted,
      })),
      error_count: purgeErrorCount,
    },
  };
});
