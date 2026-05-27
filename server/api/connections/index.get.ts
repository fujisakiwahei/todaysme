// =============================================================================
// GET /api/connections
// 現在ログイン中のユーザーの外部サービス連携状況を返す。
// SPEC §11.2 / §12.1: 平文トークンは絶対に返さない (has_token bool のみ)。
// =============================================================================
import {
  connectionListResponseSchema,
  type ConnectionSummary,
  type ServiceProvider,
} from "../../../shared/schemas";
import { requireUserId } from "../../utils/auth";
import { pickPrimaryConnectionRow, listServiceConnections } from "../../utils/serviceConnection";
import { parseOrThrow } from "../../utils/validation";

const PROVIDERS: ServiceProvider[] = ["oura", "google", "toggl"];

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const rows = await listServiceConnections(userId);

  // 3 サービス分必ず返す。未連携は status=disconnected / has_token=false。
  // Issue #131 Phase 4+: Google は同一ユーザーに 0..N 行存在しうるため、
  // 「最も active な 1 行」を決定的に選ぶ (pickPrimaryConnectionRow)。
  // アカウント単位の詳細は /api/connections/google/accounts から取得する。
  const connections: ConnectionSummary[] = PROVIDERS.map((provider) => {
    const row = pickPrimaryConnectionRow(rows, provider);
    if (!row) {
      return {
        provider,
        status: "disconnected",
        has_token: false,
        connected_at: null,
        token_expires_at: null,
        account_email: null,
      };
    }
    return {
      provider,
      status: row.status,
      has_token: row.access_token_encrypted !== null,
      connected_at: row.connected_at,
      token_expires_at: row.token_expires_at,
      account_email: row.account_email,
    };
  });

  return parseOrThrow(connectionListResponseSchema, { connections });
});
