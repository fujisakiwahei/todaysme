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
import { listServiceConnections } from "../../utils/serviceConnection";
import { parseOrThrow } from "../../utils/validation";

const PROVIDERS: ServiceProvider[] = ["oura", "google", "toggl"];

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const rows = await listServiceConnections(userId);

  // 3 サービス分必ず返す。未連携は status=disconnected / has_token=false。
  // Issue #131 Phase 2 過渡期: Google は最大 1 行前提で動く (Phase 1b 適用後に
  // 複数行が許可される)。Phase 6 で /api/connections/google/accounts に
  // 分離する想定だが、当面は最初に見つけた 1 行を返す。
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  const connections: ConnectionSummary[] = PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
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
