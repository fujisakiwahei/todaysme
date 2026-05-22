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
// =============================================================================
import type {
  ApiErrorItem,
  ServiceProvider,
  SyncStatusEntry,
} from "../../shared/schemas";

import { ServiceNotConnectedError } from "./serviceConnection";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { syncGoogleForDate } from "./syncGoogle";
import { syncOuraForDate } from "./syncOura";
import {
  markSyncFailed,
  markSyncSuccess,
  tryAcquireSyncLock,
  type SyncStatusRow,
} from "./syncLock";
import { syncTogglForDate } from "./syncToggl";

interface ProviderSyncContext {
  userId: string;
  targetDate: string;
  timezone: string;
}

type SyncRunner = (ctx: ProviderSyncContext) => Promise<void>;

const RUNNERS: Record<ServiceProvider, SyncRunner> = {
  oura: ({ userId, targetDate, timezone }) =>
    syncOuraForDate(userId, targetDate, timezone),
  google: ({ userId, targetDate, timezone }) =>
    syncGoogleForDate(userId, targetDate, timezone),
  toggl: ({ userId, targetDate, timezone }) =>
    syncTogglForDate(userId, targetDate, timezone),
};

const ALL_PROVIDERS: readonly ServiceProvider[] = ["oura", "google", "toggl"];

export interface RefreshUserDateResult {
  sync_statuses: SyncStatusEntry[];
  errors: ApiErrorItem[];
}

export interface RefreshUserDateOptions {
  // 呼び出し側が既に取得済みの場合は再取得を避けるため受け取れるようにする。
  // cron では全 user 共通で 14 日ぶん回すので、user ごとに 1 回だけ読めば済む。
  timezone?: string;
  connected?: Set<ServiceProvider>;
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

export async function loadConnectedProviders(
  userId: string,
): Promise<Set<ServiceProvider>> {
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
    if (provider === "oura" || provider === "google" || provider === "toggl") {
      set.add(provider);
    }
  }
  return set;
}

function toStatusEntry(
  source: ServiceProvider,
  row: SyncStatusRow,
): SyncStatusEntry {
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
    await RUNNERS[provider](ctx);
    const updated = await markSyncSuccess(userId, targetDate, provider, lockId);
    // updated === null = 自分の lock が stale 奪取された。新 worker が
    // 最終 status を書くので、ここでは何も push しない。
    if (updated) outcome.statuses.push(toStatusEntry(provider, updated));
  } catch (e) {
    // ServiceNotConnectedError はロック取得後に判明する稀ケース (connections と
    // 復号結果がズレている等)。それも含めて failed として記録する。
    const message =
      e instanceof ServiceNotConnectedError
        ? "service is not connected"
        : summarizeError(e);
    try {
      const updated = await markSyncFailed(
        userId,
        targetDate,
        provider,
        lockId,
        message,
      );
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
  options: RefreshUserDateOptions = {},
): Promise<RefreshUserDateResult> {
  const [timezone, connected] = await Promise.all([
    options.timezone !== undefined
      ? Promise.resolve(options.timezone)
      : loadUserTimezone(userId),
    options.connected !== undefined
      ? Promise.resolve(options.connected)
      : loadConnectedProviders(userId),
  ]);

  const sync_statuses: SyncStatusEntry[] = [];
  const errors: ApiErrorItem[] = [];

  // 各 provider は独立したテーブル / 外部 API に書くため並列実行する (Issue #140)。
  // refreshProvider 内で全例外を outcome に詰めて正常 resolve するので
  // Promise.allSettled の rejected ケースは「想定外バグ」のみ。
  const ctx = { userId, targetDate, timezone };
  const targets = ALL_PROVIDERS.filter((p) => connected.has(p));
  const settled = await Promise.allSettled(
    targets.map((provider) => refreshProvider(provider, ctx)),
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
