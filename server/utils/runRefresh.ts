// =============================================================================
// 1 ユーザー × 1 日付の refresh 共通ロジック (Issue #40)
// SPEC §9.2 / §10.4 / §11.3
//
//   - POST /api/summary/refresh (Issue #39) と GET /api/cron/daily (Issue #40)
//     から共有する。ロック奪取 → 外部 API 同期 → 成否反映までを 1 関数で扱う。
//   - 部分失敗を許容し、サービス単位で daily_sync_statuses を更新する。
//   - 未連携サービスは skip しレスポンスにも含めない (連携サービスのみ可視化)。
//   - 平文トークンは内部の sync runner / getValidAccessToken に閉じ込め、
//     呼び出し元に渡さない (SPEC §12.1)。
//   - Issue #176: refresh パス内で `service_connections` を何度も SELECT して
//     いた問題に対処するため、入口で 1 回だけ全行 (トークン列込み) を引き、
//     その snapshot を各 sync 関数に引数として渡す。401 リトライ後の refresh
//     書き戻しは serviceConnection.runWithRetry が DB から再読みする (現状維持)。
// =============================================================================
import {
  TOGGL_RATE_LIMIT_MARKER,
  type ApiErrorItem,
  type ServiceProvider,
  type SyncStatusEntry,
} from "../../shared/schemas";

import { TogglRateLimitError } from "./getTogglData";
import {
  loadServiceConnectionsForUser,
  pickConnectedRow,
  pickConnectedRows,
  ServiceNotConnectedError,
  type ServiceConnectionTokenRow,
} from "./serviceConnection";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { syncGoogleForDate } from "./syncGoogle";
import { syncOuraForDate } from "./syncOura";
import {
  markSyncFailed,
  markSyncSuccess,
  tryAcquireSyncLock,
  type SyncStatusRow,
} from "./syncLock";
import { syncTodoistForDate } from "./syncTodoist";
import { syncTogglForDate } from "./syncToggl";

interface ProviderSyncContext {
  userId: string;
  targetDate: string;
  timezone: string;
}

type SyncRunner = (
  ctx: ProviderSyncContext,
  connections: readonly ServiceConnectionTokenRow[]
) => Promise<void>;

// 各 provider の sync 入口。事前取得済みの connection rows から自分の行を
// 取り出して sync 関数に渡す。Oura / Toggl は 1 行前提、Google は複数行ありうる。
const RUNNERS: Record<ServiceProvider, SyncRunner> = {
  oura: ({ userId, targetDate, timezone }, connections) => {
    const row = pickConnectedRow(connections, "oura");
    if (!row) throw new ServiceNotConnectedError("oura");
    return syncOuraForDate(userId, targetDate, timezone, row);
  },
  google: ({ userId, targetDate, timezone }, connections) =>
    syncGoogleForDate(userId, targetDate, timezone, pickConnectedRows(connections, "google")),
  toggl: ({ userId, targetDate, timezone }, connections) => {
    const row = pickConnectedRow(connections, "toggl");
    if (!row) throw new ServiceNotConnectedError("toggl");
    return syncTogglForDate(userId, targetDate, timezone, row);
  },
  todoist: ({ userId, targetDate, timezone }, connections) => {
    const row = pickConnectedRow(connections, "todoist");
    if (!row) throw new ServiceNotConnectedError("todoist");
    return syncTodoistForDate(userId, targetDate, timezone, row);
  },
};

const ALL_PROVIDERS: readonly ServiceProvider[] = ["oura", "google", "toggl", "todoist"];

export interface RefreshUserDateResult {
  sync_statuses: SyncStatusEntry[];
  errors: ApiErrorItem[];
}

export interface RefreshUserDateOptions {
  // cron では全 user 共通で 14 日ぶん回すので、user ごとに 1 回だけ読めば済む。
  timezone?: string;
}

export async function loadUserTimezone(userId: string): Promise<string> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("users")
    .select("timezone")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`failed to read user timezone: ${error.message}`);
  }
  // users.timezone は NOT NULL DEFAULT 'Asia/Tokyo'。
  // ただし auth.users トリガで挿入される前に呼ばれる可能性に備えてフォールバック。
  return (data?.timezone as string | undefined) ?? "Asia/Tokyo";
}

export async function loadConnectedProviders(userId: string): Promise<Set<ServiceProvider>> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("service_connections")
    .select("provider, status")
    .eq("user_id", userId)
    .eq("status", "connected");
  if (error) {
    throw new Error(`failed to read service_connections: ${error.message}`);
  }
  const set = new Set<ServiceProvider>();
  for (const row of data ?? []) {
    const provider = (row as { provider: ServiceProvider }).provider;
    if (
      provider === "oura" ||
      provider === "google" ||
      provider === "toggl" ||
      provider === "todoist"
    ) {
      set.add(provider);
    }
  }
  return set;
}

function toStatusEntry(source: ServiceProvider, row: SyncStatusRow): SyncStatusEntry {
  return {
    source,
    status: row.status,
    last_synced_at: row.last_synced_at,
    error_message: row.error_message,
  };
}

// Error -> 短い message (機密混入を避けるため Error.message のみ)
function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "unknown error";
}

// Toggl 429: UI 側で専用バナーに切り替えるため、error_message の先頭に
// マーカーを付ける。本文は後段の表示のために短く構造化しておく
// (`[TOGGL_RATE_LIMIT] retry_after=<秒>` 形式。秒は不明なら省略)。
// Issue #185。
function formatTogglRateLimitMessage(err: TogglRateLimitError): string {
  return err.retryAfterSeconds !== null
    ? `${TOGGL_RATE_LIMIT_MARKER} retry_after=${err.retryAfterSeconds}`
    : TOGGL_RATE_LIMIT_MARKER;
}

interface ProviderRefreshOutcome {
  statuses: SyncStatusEntry[];
  errors: ApiErrorItem[];
}

// 1 provider 分の refresh (ロック取得 → sync → status 更新)。
// 部分失敗を許容するため、内部で発生したエラーはすべて outcome に詰めて
// 正常 resolve する。呼び出し元の Promise.allSettled で reject 扱いされない
// ようにすることで、他 provider の成功結果が握り潰されないようにしている。
async function refreshProvider(
  provider: ServiceProvider,
  ctx: ProviderSyncContext,
  connections: readonly ServiceConnectionTokenRow[]
): Promise<ProviderRefreshOutcome> {
  const { userId, targetDate } = ctx;
  const outcome: ProviderRefreshOutcome = { statuses: [], errors: [] };

  let lock;
  try {
    lock = await tryAcquireSyncLock(userId, targetDate, provider);
  } catch (e) {
    // ロック取得自体に失敗 = DB 異常。ステータス更新もできないので errors のみに残す。
    outcome.errors.push({ service: provider, message: summarizeError(e) });
    return outcome;
  }

  if (!lock.acquired) {
    // 他 process が走行中 (in_progress)。現在のステータスをそのまま返す。
    if (lock.current) {
      outcome.statuses.push(toStatusEntry(provider, lock.current));
    }
    return outcome;
  }

  // lock.acquired=true なら lockId は必ず非 null (型上は string|null)。
  const lockId = lock.lockId!;

  try {
    await RUNNERS[provider](ctx, connections);
    const updated = await markSyncSuccess(userId, targetDate, provider, lockId);
    // updated === null = 自分の lock が stale 奪取された。新 worker が
    // 最終 status を書くので、ここでは何も push しない。
    if (updated) outcome.statuses.push(toStatusEntry(provider, updated));
  } catch (e) {
    // ServiceNotConnectedError はロック取得後に判明する稀ケース (connections と
    // 復号結果がズレている等)。それも含めて failed として記録する。
    // Toggl の 429 (Issue #185) は UI 側で「少し待ってリロードを促す」専用
    // バナーに切り替えるため、shared マーカー付きのメッセージで記録する。
    // 他 provider の同期はそのまま継続する (refresh は Promise.allSettled)。
    const message =
      e instanceof TogglRateLimitError
        ? formatTogglRateLimitMessage(e)
        : e instanceof ServiceNotConnectedError
          ? "service is not connected"
          : summarizeError(e);
    try {
      const updated = await markSyncFailed(userId, targetDate, provider, lockId, message);
      if (updated) outcome.statuses.push(toStatusEntry(provider, updated));
      // updated === null も「lock を奪われた」だけなので errors 側にだけ載せる。
    } catch (markErr) {
      // 万一 failed への更新も失敗したら errors にだけ残す。
      outcome.errors.push({
        service: provider,
        message: `mark failed errored: ${summarizeError(markErr)}`,
      });
    }
    outcome.errors.push({ service: provider, message });
  }

  return outcome;
}

export async function refreshUserDate(
  userId: string,
  targetDate: string,
  options: RefreshUserDateOptions = {}
): Promise<RefreshUserDateResult> {
  // Issue #176: timezone と service_connections の 1 ユーザー全行を並列で取る。
  // service_connections はここで取った snapshot を各 sync 関数に渡し、refresh
  // パス内での重複読みをゼロにする。401 後の refresh 書き戻しは
  // runWithRetry 側が DB を再読みするため (= 同 row が古くなっても整合性が
  // 取れる仕組み)、ここでの snapshot 利用は安全。
  const [timezone, connections] = await Promise.all([
    options.timezone !== undefined ? Promise.resolve(options.timezone) : loadUserTimezone(userId),
    loadServiceConnectionsForUser(userId),
  ]);

  const connectedProviders = new Set<ServiceProvider>();
  for (const row of connections) {
    if (row.status === "connected") {
      connectedProviders.add(row.provider);
    }
  }

  const sync_statuses: SyncStatusEntry[] = [];
  const errors: ApiErrorItem[] = [];

  // 各 provider は独立したテーブル / 外部 API に書くため並列実行する (Issue #140)。
  // refreshProvider 内で全例外を outcome に詰めて正常 resolve するので
  // Promise.allSettled の rejected ケースは「想定外バグ」のみ。
  const ctx = { userId, targetDate, timezone };
  const targets = ALL_PROVIDERS.filter((p) => connectedProviders.has(p));
  const settled = await Promise.allSettled(
    targets.map((provider) => refreshProvider(provider, ctx, connections))
  );

  // ALL_PROVIDERS の順序を維持するため targets と settled の index を合わせて読む。
  settled.forEach((result, index) => {
    const provider = targets[index]!;
    if (result.status === "fulfilled") {
      sync_statuses.push(...result.value.statuses);
      errors.push(...result.value.errors);
    } else {
      // refreshProvider が想定外 throw した場合のフォールバック。
      errors.push({
        service: provider,
        message: summarizeError(result.reason),
      });
    }
  });

  return { sync_statuses, errors };
}
