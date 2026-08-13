import {
  freeTimeNoteCreateRequestSchema,
  freeTimeNoteMutationResponseSchema,
} from "../../../shared/schemas";
import { requireUserId } from "../../utils/auth";
import { getSupabaseAdmin } from "../../utils/supabaseAdmin";
import { parseOrThrow } from "../../utils/validation";

const NOTE_COLUMNS = "id, target_date, gap_start_at, gap_end_at, content, created_at, updated_at";

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const body = parseOrThrow(freeTimeNoteCreateRequestSchema, await readBody(event));

  const gapStart = new Date(body.gap_start_at).getTime();
  const gapEnd = new Date(body.gap_end_at).getTime();
  if (gapStart >= gapEnd) {
    throw createError({
      statusCode: 400,
      statusMessage: "gap_start_at must be before gap_end_at",
    });
  }
  if (gapEnd > Date.now()) {
    throw createError({
      statusCode: 400,
      statusMessage: "free-time note can only be added to a completed gap",
    });
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("free_time_notes")
    .insert({
      user_id: userId,
      target_date: body.target_date,
      gap_start_at: body.gap_start_at,
      gap_end_at: body.gap_end_at,
      content: body.content,
    })
    .select(NOTE_COLUMNS)
    .single();

  if (error?.code === "23505") {
    throw createError({
      statusCode: 409,
      statusMessage: "a note already exists for this free-time range",
    });
  }
  if (error) {
    throw createError({
      statusCode: 500,
      statusMessage: "failed to create free-time note",
    });
  }

  return parseOrThrow(freeTimeNoteMutationResponseSchema, { note: data });
});
