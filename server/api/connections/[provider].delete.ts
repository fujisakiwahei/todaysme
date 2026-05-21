// =============================================================================
// DELETE /api/connections/:provider
// SPEC §11.2 / Issue #52
//
//   service_connections の status を disconnected に落とし、暗号化トークンを
//   null 化する。行自体は履歴として残す。
// =============================================================================
import { disconnectParamsSchema } from "../../../shared/schemas";
import { requireUserId } from "../../utils/auth";
import { disconnectServiceConnection } from "../../utils/serviceConnection";
import { parseOrThrow } from "../../utils/validation";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const params = parseOrThrow(disconnectParamsSchema, getRouterParams(event));
  await disconnectServiceConnection(userId, params.provider);
  return { ok: true };
});
