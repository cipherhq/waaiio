import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { verifyOtpToken } from '@/lib/otp-token';
import { logger } from '@/lib/logger';
import { findWebIntake, openBeforeBookingIntake, toE164, webBeforeBookingForm } from '@/lib/intake/send';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/**
 * #963: the public booking page asks whether the chosen service needs a
 * before-booking form and, if so, opens one (Owner decision 2026-11-10: the form
 * is answered inside the page before booking). Only a client whose email was just
 * verified may ask. The token is returned once, to that client, to show the form;
 * it is never logged or stored (only its sha256 is).
 */
export async function POST(request: NextRequest) {
  const limited = await rateLimitResponseAsync(getRateLimitKey(request, 'public-intake'), 20, 60_000);
  if (limited) return limited;
  try {
    const body = await request.json().catch(() => ({}));
    const businessSlug = typeof body?.businessSlug === 'string' ? body.businessSlug : '';
    const serviceId = typeof body?.serviceId === 'string' ? body.serviceId : '';
    const email = typeof body?.guestEmail === 'string' ? body.guestEmail.trim().toLowerCase() : '';
    if (!businessSlug || !UUID.test(serviceId) || !email) return json({ error: 'Missing required fields' }, 400);

    const verified = typeof body?.otpToken === 'string' ? verifyOtpToken(body.otpToken) : null;
    if (!verified || verified !== email) return json({ error: 'Email verification expired or invalid' }, 403);

    const phone = toE164(typeof body?.guestPhone === 'string' ? body.guestPhone : null);
    if (!phone) return json({ code: 'phone_required', error: 'Please add your phone number.' }, 400);

    const db = createServiceClient();
    const { data: business } = await db.from('businesses').select('id, subscription_tier')
      .eq('slug', businessSlug).eq('status', 'active').maybeSingle();
    if (!business) return json({ error: 'Business not found' }, 404);

    const form = await webBeforeBookingForm(db, { businessId: business.id, tier: business.subscription_tier, serviceId, email });
    if (!form) return json({ required: false });

    const existing = typeof body?.intakeId === 'string' && UUID.test(body.intakeId)
      ? await findWebIntake(db, { businessId: business.id, serviceId, formId: form.formId, phone, intakeId: body.intakeId })
      : null;
    if (existing?.status === 'submitted') return json({ required: true, intakeId: existing.id, submitted: true });

    const opened = await openBeforeBookingIntake(db, {
      businessId: business.id, serviceId, formId: form.formId, phone,
      existingIntakeId: existing?.status === 'pending' ? existing.id : null,
    });
    if (!opened) return json({ error: 'We could not open your form just now. Please try again.' }, 503);
    return json({ required: true, intakeId: opened.intakeId, token: opened.token });
  } catch (err) {
    logger.error('[PUBLIC_INTAKE] Failed:', (err as Error).message);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}
