// =============================================================================
// POST /api/summary/refresh
// SPEC §9.1 / §9.2 / §10.4 / §11.3 / §12.1 / §12.3 / Issue #39
//
//   - 対象日のデータを Oura / Google / Toggl から再取得し、DB に upsert する。
//   - `daily_sync_statuses` をサービス単位の条件付き UPDATE で `in_progress` に
//     切り替えてから外部 API を叩く。奪取できない場合 (= 他の refresh が走行中)
//     は skip して既存ステータスをレスポンスに含める。
//   - サービス単位で sync status を更新 (部分成功を許容)。失敗したサービス名と
//     メッセージは `errors[]` に乗せる。
//   - 連携していない (= service_connections が無い / disconnected) サービスは
//     ロックを取らずスキップし、レスポンスにも含めない。
//   - 平文の access_token はクライアントに返さない / ログに出さない (SPEC §12.1)。
//   - mark* に lockId (奪取時 sync_started_at) を渡して ownership 検査するため、
//     stale 奪取された場合は古い worker が新 worker の status を上書きしない。
// =============================================================================
import {
  summaryRefreshRequestSchema,
  summaryRefreshResponseSchema,
  type ApiErrorItem,
  type ServiceProvider,
  type SyncStatusEntry,
} from "../../../shared/schemas";
import { requireUserId } from "../../utils/auth";
import { ServiceNotConnectedError } from "../../utils/serviceConnection";
import { getSupabaseAdmin } from "../../utils/supabaseAdmin";
import { syncGoogleForDate } from "../../utils/syncGoogle";
import { syncOuraForDate } from "../../utils/syncOura";
import {
  markSyncFailed,
  markSyncSuccess,
  tryAcquireSyncLock,
  type SyncStatusRow,
} from "../../utils/syncLock";
import { syncTogglForDate } from "../../utils/syncToggl";
import { parseOrThrow } from "../../utils/validation";

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

async function loadUserTimezone(userId: string): Promise<string> {
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

async function loadConnectedProviders(
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

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const raw = await readBody(event);
  const body = parseOrThrow(summaryRefreshRequestSchema, raw);

  const [timezone, connected] = await Promise.all([
    loadUserTimezone(userId),
    loadConnectedProviders(userId),
  ]);

  const sync_statuses: SyncStatusEntry[] = [];
  const errors: ApiErrorItem[] = [];

  // 部分失敗を許容するため、各サービスを順に処理する。1 サービスの失敗が
  // 他の sync を巻き込まないよう必ず try/catch で受ける。
  for (const provider of ALL_PROVIDERS) {
    if (!connected.has(provider)) continue;

    let lock;
    try {
      lock = await tryAcquireSyncLock(userId, body.date, provider);
    } catch (e) {
      // ロック取得自体に失敗 = DB 異常。ステータス更新もできないので errors のみに残す。
      errors.push({ service: provider, message: summarizeError(e) });
      continue;
    }

    if (!lock.acquired) {
      // 他 process が走行中 (in_progress)。現在のステータスをそのまま返す。
      if (lock.current) {
        sync_statuses.push(toStatusEntry(provider, lock.current));
      }
      continue;
    }

    // lock.acquired=true なら lockId は必ず非 null (型上は string|null)。
    const lockId = lock.lockId!;

    try {
      await RUNNERS[provider]({
        userId,
        targetDate: body.date,
        timezone,
      });
      const updated = await markSyncSuccess(
        userId,
        body.date,
        provider,
        lockId,
      );
      // updated === null = 自分の lock が stale 奪取された。新 worker が
      // 最終 status を書くので、ここでは何も push しない。
      if (updated) sync_statuses.push(toStatusEntry(provider, updated));
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
          body.date,
          provider,
          lockId,
          message,
        );
        if (updated) sync_statuses.push(toStatusEntry(provider, updated));
        // updated === null も「lock を奪われた」だけなので errors 側にだけ載せる。
      } catch (markErr) {
        // 万一 failed への更新も失敗したら errors にだけ残す。
        errors.push({
          service: provider,
          message: `mark failed errored: ${summarizeError(markErr)}`,
        });
      }
      errors.push({ service: provider, message });
    }
  }

  return parseOrThrow(summaryRefreshResponseSchema, {
    target_date: body.date,
    sync_statuses,
    errors: errors.length > 0 ? errors : undefined,
  });
});
