import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { parseQuestions, QUESTION_BODY_LIMIT } from '@/lib/parties/rsvp-questions';
import { partyRsvpError } from '@/lib/parties/rsvp-completion';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ partyId: string }> };
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
export async function GET(request: NextRequest, context: Context) { return handle(request, context, false); }
export async function PUT(request: NextRequest, context: Context) { return handle(request, context, true); }
async function handle(request: NextRequest, context: Context, save: boolean) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;
  const { partyId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(partyId)) return reply({ error: 'Invalid party.' }, 400);
  let payload = null;
  if (save) {
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > QUESTION_BODY_LIMIT) return reply({ error: 'Questions are too large.' }, 413);
      const body = JSON.parse(raw);
      if (!body || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error('Invalid revision.');
      payload = { questions: parseQuestions(body.questions), revision: body.revision };
    } catch (error) { return reply({ error: error instanceof Error ? error.message : 'Invalid questions.' }, 400); }
  }
  const { data, error } = await auth.service.rpc('party_questions_487', { p_party: partyId, p_actor: auth.user.id, p_payload: payload });
  if (error) { const result = partyRsvpError(error.code); return reply(result, result.status); }
  return reply(data);
}
