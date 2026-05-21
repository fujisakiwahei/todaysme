// =============================================================================
// daily_sync_statuses をベースにした同期ロック (Issue #39)
// SPEC §9.2 / §10.4 / §11.2
//
//   - `unique(user_id, target_date, source)` 行を条件付き UPDATE して
//     `status = in_progress` に切り替えることで多重実行を抑止する。
//   - 既に in_progress でも `sync_started_at` が `STALE_LOCK_MINUTES` より
//     古ければ timeout 扱いで奪取できる (process が落ちて回復不能になるのを防ぐ)。
//   - サービス単位で sync status を更新する (部分成功を許容)。
//   - markSyncSuccess / markSyncFailed は「自分が握っている lock」だけを更新
//     対象にするため、`sync_started_at` (= 奪取時に書き込んだ値) を ownership
//     キーとして渡す (Codex review)。stale 奪取で別 worker に lock を取られた
//     後に古い worker が status を上書きしてしまう事故を防ぐ。
// =============================================================================
import type { ServiceProvider, SyncStatus } from "../../shared/schemas";

import { getSupabaseAdmin } from "./supabaseAdmin";

const DAILY_SYNC_STATUSES = "daily_sync_statuses";

// `sync_started_at` がこの分数より古い in_progress はロックを奪える。
// MVP の単一ユーザー運用では Vercel Function のハードリミット (15 分前後) を
// 越える sync は事故扱いなので、ここでは余裕を持って 10 分にしている。
const STALE_LOCK_MINUTES = 10;

export interface SyncStatusRow {
  status: SyncStatus;
  sync_started_at: string | null;
  last_synced_at: string | null;
  error_message: string | null;
}

export interface AcquireLockResult {
  acquired: boolean;
  // 自分が取得した lock を特定する値 (= 書き込んだ sync_started_at)。
  // markSyncSuccess / markSyncFailed にそのまま渡すこと。
  // acquired=false のときは null。
  lockId: string | null;
  // acquired=false の場合に「いま誰が握っているか」を返す。null は行が読めなかったケース。
  current: SyncStatusRow | null;
}

const SELECT_COLS = "status, sync_started_at, last_synced_at, error_message";

// =============================================================================
// tryAcquireSyncLock
//   - 行がなければ INSERT (status=idle) → その後 conditional UPDATE で奪取
//   - 条件: 現在 in_progress ではない OR sync_started_at が stale
// =============================================================================
export async function tryAcquireSyncLock(
  userId: string,
  targetDate: string,
  source: ServiceProvider,
): Promise<AcquireLockResult> {
  const admin = getSupabaseAdmin();
  const now = new Date();
  const nowIso = now.toISOString();
  const staleCutoff = new Date(
    now.getTime() - STALE_LOCK_MINUTES * 60 * 1000,
  ).toISOString();

  // 行が無い場合に備えて idle で先に INSERT する (既にあれば ignore)。
  const { error: upsertError } = await admin.from(DAILY_SYNC_STATUSES).upsert(
    {
      user_id: userId,
      target_date: targetDate,
      source,
      status: "idle",
      updated_at: nowIso,
    },
    { onConflict: "user_id,target_date,source", ignoreDuplicates: true },
  );
  if (upsertError) {
    throw new Error(`failed to ensure sync status row: ${upsertError.message}`);
  }

  // 条件付き UPDATE で奪取を試みる。
  const { data, error } = await admin
    .from(DAILY_SYNC_STATUSES)
    .update({
      status: "in_progress",
      sync_started_at: nowIso,
      error_message: null,
      updated_at: nowIso,
    })
    .eq("user_id", userId)
    .eq("target_date", targetDate)
    .eq("source", source)
    .or(`status.neq.in_progress,sync_started_at.lt.${staleCutoff}`)
    .select(SELECT_COLS);

  if (error) {
    throw new Error(`failed to acquire sync lock: ${error.message}`);
  }

  if (data && data.length > 0) {
    // 自分が書き込んだ sync_started_at (= nowIso) を lockId として保持する。
    // この値は markSyncSuccess / markSyncFailed の WHERE 条件として渡され、
    // 別 worker に lock を奪われた後の上書きを防ぐ。
    return {
      acquired: true,
      lockId: nowIso,
      current: data[0] as SyncStatusRow,
    };
  }

  // 奪取に失敗した = 別 process が走っている。現在の status を返して呼び出し側に
  // skip 判断させる。
  const { data: current, error: readError } = await admin
    .from(DAILY_SYNC_STATUSES)
    .select(SELECT_COLS)
    .eq("user_id", userId)
    .eq("target_date", targetDate)
    .eq("source", source)
    .maybeSingle();
  if (readError) {
    throw new Error(`failed to read sync status: ${readError.message}`);
  }

  return {
    acquired: false,
    lockId: null,
    current: (current as SyncStatusRow | null) ?? null,
  };
}

// =============================================================================
// markSyncSuccess / markSyncFailed
//   - lockId (= 奪取時に書き込んだ sync_started_at) を WHERE 条件に含めて
//     ownership を担保する。値が一致しなければ「自分の lock は別 worker に
//     stale 奪取された」とみなして no-op を返す。
//   - 返り値が null なら呼び出し側は status を上書きしない (新しい owner が
//     最終 status を書く責務を持つ)。
// =============================================================================
export async function markSyncSuccess(
  userId: string,
  targetDate: string,
  source: ServiceProvider,
  lockId: string,
): Promise<SyncStatusRow | null> {
  const admin = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  const { data, error } = await admin
    .from(DAILY_SYNC_STATUSES)
    .update({
      status: "success",
      last_synced_at: nowIso,
      error_message: null,
      updated_at: nowIso,
    })
    .eq("user_id", userId)
    .eq("target_date", targetDate)
    .eq("source", source)
    .eq("sync_started_at", lockId)
    .select(SELECT_COLS);

  if (error) {
    throw new Error(`failed to mark sync success: ${error.message}`);
  }
  if (!data || data.length === 0) return null;
  return data[0] as SyncStatusRow;
}

// =============================================================================
// markSyncFailed
//   - message は error_message カラムに記録する。
//   - 平文トークンや URL クエリ等の機密情報を含めないこと (呼び出し側で整形済み前提)。
//   - lockId が現在の sync_started_at と一致しないときは no-op (null を返す)。
// =============================================================================
export async function markSyncFailed(
  userId: string,
  targetDate: string,
  source: ServiceProvider,
  lockId: string,
  message: string,
): Promise<SyncStatusRow | null> {
  const admin = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  // error_message カラムは text。極端に長い stack 等を入れないよう 500 文字でカット。
  const truncated = message.length > 500 ? message.slice(0, 500) : message;

  const { data, error } = await admin
    .from(DAILY_SYNC_STATUSES)
    .update({
      status: "failed",
      error_message: truncated,
      updated_at: nowIso,
    })
    .eq("user_id", userId)
    .eq("target_date", targetDate)
    .eq("source", source)
    .eq("sync_started_at", lockId)
    .select(SELECT_COLS);

  if (error) {
    throw new Error(`failed to mark sync failed: ${error.message}`);
  }
  if (!data || data.length === 0) return null;
  return data[0] as SyncStatusRow;
}
