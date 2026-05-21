// =============================================================================
// Oura 同期ヘルパ (Issue #39)
// SPEC §10.4 / §11.3
//
//   - `target_date` ± 1 日の sleep を Oura API から取得し、`oura_sleep_records`
//     に external id (`oura_sleep_id`) 単位で upsert する。
//   - 取得結果に含まれない `target_date == 対象日` の既存レコードは
//     `is_deleted = true` でソフトデリート (SPEC §11.3)。
//   - 過去日方向 / 未来日方向に ±1 日広めに引くのは、ユーザータイムゾーンと
//     Oura 側 `day` がズレるケース・wake_at の補正で target_date が移動する
//     ケースを取りこぼさないため (`oura_sleep_id` を保持していれば upsert
//     で吸収できる)。
//   - access_token は getOuraData が内部で withFreshAccessToken を介して取得し、
//     未連携の場合は ServiceNotConnectedError ("oura") を投げる (Issue #75)。
// =============================================================================
import { getOuraData } from "./getOuraData";
import { getSupabaseAdmin } from "./supabaseAdmin";

const OURA_SLEEP_RECORDS = "oura_sleep_records";

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function syncOuraForDate(
  userId: string,
  targetDate: string,
  timezone: string,
): Promise<void> {
  const startDate = shiftDate(targetDate, -1);
  const endDate = shiftDate(targetDate, 1);

  const fetched = await getOuraData({
    userId,
    startDate,
    endDate,
    timezone,
  });

  const admin = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  if (fetched.sleeps.length > 0) {
    const rows = fetched.sleeps.map((s) => ({
      user_id: userId,
      target_date: s.target_date,
      oura_sleep_id: s.oura_sleep_id,
      sleep_start_at: s.sleep_start_at,
      wake_at: s.wake_at,
      sleep_minutes: s.sleep_minutes,
      is_deleted: false,
      updated_at: nowIso,
    }));

    const { error: upsertError } = await admin
      .from(OURA_SLEEP_RECORDS)
      .upsert(rows, { onConflict: "user_id,oura_sleep_id" });
    if (upsertError) {
      throw new Error(
        `failed to upsert ${OURA_SLEEP_RECORDS}: ${upsertError.message}`,
      );
    }
  }

  // 対象日に紐づく既存行のうち、今回取得した sleep id 集合に含まれないものは
  // ソース側で消えたとみなしてソフトデリートする。
  const keepIds = new Set(fetched.sleeps.map((s) => s.oura_sleep_id));
  await softDeleteMissing({
    table: OURA_SLEEP_RECORDS,
    externalIdCol: "oura_sleep_id",
    userId,
    targetDate,
    keepIds,
  });
}

interface SoftDeleteMissingInput {
  table: string;
  externalIdCol: string;
  userId: string;
  targetDate: string;
  keepIds: Set<string>;
}

export async function softDeleteMissing(
  input: SoftDeleteMissingInput,
): Promise<void> {
  const admin = getSupabaseAdmin();

  const { data: existing, error: readError } = await admin
    .from(input.table)
    .select(input.externalIdCol)
    .eq("user_id", input.userId)
    .eq("target_date", input.targetDate)
    .eq("is_deleted", false);

  if (readError) {
    throw new Error(`failed to read ${input.table}: ${readError.message}`);
  }

  const toDelete: string[] = [];
  for (const row of existing ?? []) {
    const record = row as unknown as Record<string, unknown>;
    const id = record[input.externalIdCol];
    if (typeof id === "string" && !input.keepIds.has(id)) {
      toDelete.push(id);
    }
  }

  if (toDelete.length === 0) return;

  const { error: updateError } = await admin
    .from(input.table)
    .update({ is_deleted: true, updated_at: new Date().toISOString() })
    .eq("user_id", input.userId)
    .eq("target_date", input.targetDate)
    .in(input.externalIdCol, toDelete);

  if (updateError) {
    throw new Error(
      `failed to soft-delete ${input.table}: ${updateError.message}`,
    );
  }
}
