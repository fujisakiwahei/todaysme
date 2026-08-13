import {
  freeTimeNoteDeleteResponseSchema,
  freeTimeNoteParamsSchema,
} from "../../../shared/schemas";
import { requireUserId } from "../../utils/auth";
import { getSupabaseAdmin } from "../../utils/supabaseAdmin";
import { parseOrThrow } from "../../utils/validation";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const { id } = parseOrThrow(freeTimeNoteParamsSchema, getRouterParams(event));

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("free_time_notes")
    .delete()
    .eq("id", id)
    .eq("user_id", userId)
    .select("id")
    .maybeSingle();

  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: "failed to delete free-time note",
    });
  }
  if (!data) {
    throw createError({ statusCode: 404, statusMessage: "free-time note not found" });
  }

  return parseOrThrow(freeTimeNoteDeleteResponseSchema, { ok: true });
});
