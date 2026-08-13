import {
  freeTimeNoteMutationResponseSchema,
  freeTimeNoteParamsSchema,
  freeTimeNoteUpdateRequestSchema,
} from "../../../shared/schemas";
import { requireUserId } from "../../utils/auth";
import { getSupabaseAdmin } from "../../utils/supabaseAdmin";
import { parseOrThrow } from "../../utils/validation";

const NOTE_COLUMNS = "id, target_date, gap_start_at, gap_end_at, content, created_at, updated_at";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const { id } = parseOrThrow(freeTimeNoteParamsSchema, getRouterParams(event));
  const body = parseOrThrow(freeTimeNoteUpdateRequestSchema, await readBody(event));

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("free_time_notes")
    .update({ content: body.content, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .select(NOTE_COLUMNS)
    .maybeSingle();

  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: "failed to update free-time note",
    });
  }
  if (!data) {
    throw createError({ statusCode: 404, statusMessage: "free-time note not found" });
  }

  return parseOrThrow(freeTimeNoteMutationResponseSchema, { note: data });
});
