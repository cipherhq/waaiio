import type { SupabaseClient } from '@supabase/supabase-js';
import { QUESTION_BODY_LIMIT } from './rsvp-questions';

export function partyRsvpError(code?: string) {
  if (code === '42501') return { status: 403, error: 'Invitation unavailable.' };
  if (code === '40001') return { status: 409, error: 'Questions changed. Refresh the invitation and review your answers.', stale: true };
  if (['23514', 'P0001'].includes(code || '')) return { status: 409, error: 'The guest count conflicts with current party or table capacity.' };
  if (['22023', '22P02', '22003'].includes(code || '')) return { status: 400, error: 'Check the required answers and guest count.' };
  return { status: 503, error: 'Unable to confirm the save. Refresh before retrying.' };
}
export async function completePartyRsvp(db: SupabaseClient, token: string, input: Record<string, unknown>, bot?: { sender: string; businessId: string }) {
  if (new TextEncoder().encode(JSON.stringify(input)).length > QUESTION_BODY_LIMIT ||
    !['accepted', 'maybe', 'declined'].includes(String(input.status)) ||
    input.plus_ones !== undefined && (!Number.isSafeInteger(input.plus_ones) || Number(input.plus_ones) < 0))
    return { ok: false as const, ...partyRsvpError('22023') };
  const payload: Record<string, unknown> = { status: input.status, plus_ones: input.plus_ones ?? 0 };
  // Non-acceptance never submits a stale draft or clears historical answers.
  if (input.status === 'accepted') { payload.answers = input.answers ?? {}; payload.revision = input.revision; }
  if (Object.hasOwn(input, 'dietary_notes')) payload.dietary_notes = input.dietary_notes;
  const { data, error } = await db.rpc('complete_party_rsvp_487', {
    p_token: token, p_payload: payload, p_sender: bot?.sender ?? null, p_business: bot?.businessId ?? null,
  });
  if (error) return { ok: false as const, ...partyRsvpError(error.code) };
  return { ok: true as const, saved: data };
}
