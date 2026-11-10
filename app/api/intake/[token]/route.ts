import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { answerableFields, checkIntakeAnswers } from '@/lib/intake/answers';

/**
 * Client intake link (#963 lane 2). The token is a single-use secret sent to
 * one client; only its sha256 is stored (booking_intakes.token_hash, M526).
 * Never log the token, and never return the phone number or saved answers.
 */

const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

type Db = ReturnType<typeof createServiceClient>;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

async function loadIntake(db: Db, token: string) {
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
  const { data: intake, error } = await db
    .from('booking_intakes')
    .select('id, business_id, service_id, form_id, booking_id, status, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error) throw new Error(`intake lookup failed: ${error.code || 'unknown'}`);
  if (!intake) return null;
  const { data: form, error: formError } = await db
    .from('forms')
    .select('title, description, fields, is_active')
    .eq('id', intake.form_id)
    .eq('business_id', intake.business_id)
    .maybeSingle();
  if (formError) throw new Error(`intake form lookup failed: ${formError.code || 'unknown'}`);
  return { intake, form };
}

function isExpired(intake: { status: string; expires_at: string }) {
  return intake.status === 'expired' || Date.parse(intake.expires_at) <= Date.now();
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limited = await rateLimitResponseAsync(getRateLimitKey(req, 'intake-get'), 30, 60_000);
  if (limited) return limited;

  const { token } = await params;
  if (!TOKEN.test(token || '')) return json({ error: 'This link is not valid.' }, 404);

  try {
    const db = createServiceClient();
    const found = await loadIntake(db, token);
    if (!found || !found.form) return json({ error: 'This link is not valid.' }, 404);
    const { intake, form } = found;

    const [{ data: biz }, { data: service }, booking] = await Promise.all([
      db.from('businesses').select('name, logo_url').eq('id', intake.business_id).maybeSingle(),
      db.from('services').select('name').eq('id', intake.service_id).eq('business_id', intake.business_id).maybeSingle(),
      intake.booking_id
        ? db.from('bookings').select('date, time').eq('id', intake.booking_id).eq('business_id', intake.business_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const base = {
      business_name: biz?.name || '',
      business_logo: biz?.logo_url || null,
      service_name: service?.name || null,
      booking_date: booking.data?.date || null,
      booking_time: booking.data?.time || null,
    };

    if (intake.status === 'submitted') return json({ ...base, status: 'submitted' });
    if (isExpired(intake)) return json({ ...base, status: 'expired' });
    if (!form.is_active) return json({ ...base, status: 'unavailable' });

    return json({
      ...base,
      status: 'pending',
      title: form.title,
      description: form.description,
      fields: answerableFields(form.fields),
    });
  } catch (err) {
    logger.error('[INTAKE] Load failed:', (err as Error).message);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limited = await rateLimitResponseAsync(getRateLimitKey(req, 'intake-submit'), 10, 60_000);
  if (limited) return limited;

  const { token } = await params;
  if (!TOKEN.test(token || '')) return json({ error: 'This link is not valid.' }, 404);

  let body: { answers?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Answers are missing' }, 400);
  }

  try {
    const db = createServiceClient();
    const found = await loadIntake(db, token);
    if (!found || !found.form) return json({ error: 'This link is not valid.' }, 404);
    const { intake, form } = found;
    if (intake.status === 'submitted') return json({ status: 'submitted' });
    if (isExpired(intake)) return json({ error: 'This link has expired. Please contact the business.' }, 410);
    if (!form.is_active) return json({ error: 'This form is not accepting answers. Please contact the business.' }, 410);

    const checked = checkIntakeAnswers(form.fields, body?.answers);
    if (!checked.ok) return json({ error: checked.error }, 400);

    const { error } = await db.rpc('submit_booking_intake_526', { p_token: token, p_answers: checked.answers });
    if (error) {
      if (error.code === '42501') return json({ error: 'This link is not valid.' }, 404);
      if (error.message?.includes('expired')) return json({ error: 'This link has expired. Please contact the business.' }, 410);
      if (error.code === '22023') return json({ error: 'Please check your answers and try again.' }, 400);
      logger.error('[INTAKE] Submit failed:', error.code || 'unknown');
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
    return json({ status: 'submitted' });
  } catch (err) {
    logger.error('[INTAKE] Submit failed:', (err as Error).message);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}
