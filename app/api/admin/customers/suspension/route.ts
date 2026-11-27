import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin, type PlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { createServiceClient } from '@/lib/supabase/service';
import { adminCorsHeaders } from '@/lib/admin-cors';
import { canonicalCustomerPhone } from '@/lib/customer-suspension';
import { normalizeBlockEmail } from '@/lib/customer-block';

/**
 * Platform-wide customer suspension (#1103), extended to emails (#1166).
 *
 * GET  — blocked numbers and blocked emails (admin, support).
 * POST — block or unblock (admin, with step-up):
 *   - with `emails` (an array, possibly empty): a phone and/or emails in one
 *     change, written with their audit rows by svc_set_customer_block (M559).
 *     `phone` null means an email-only change. The step-up is bound to
 *     { phone, suspended, reason, emails } with emails trimmed, lower-cased,
 *     de-duplicated and sorted; its target is the phone, or the first email
 *     for an email-only change.
 *   - without `emails`: the phone-only change of #1103 (an admin panel that
 *     predates #1166), via svc_set_customer_suspension (M547), unchanged.
 */

export const dynamic = 'force-dynamic';

const METHODS = 'GET, POST, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin'), METHODS) });
}

export async function GET(request: NextRequest) {
  const cors = adminCorsHeaders(request.headers.get('origin'), METHODS);
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'support'] });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

  const db = createServiceClient();
  const [phones, emails] = await Promise.all([
    db.from('customer_suspensions').select('phone, reason, suspended_at').order('suspended_at', { ascending: false }),
    db.from('customer_email_blocks').select('email, phone, reason, blocked_at').order('blocked_at', { ascending: false }),
  ]);
  if (phones.error) return NextResponse.json({ error: 'Unable to load suspended customers' }, { status: 500, headers: cors });
  if (emails.error) return NextResponse.json({ error: 'Unable to load blocked emails' }, { status: 500, headers: cors });
  return NextResponse.json({ suspensions: phones.data ?? [], emailBlocks: emails.data ?? [] }, { headers: cors });
}

const MAX_EMAILS = 50;

/** Trimmed, lower-cased, de-duplicated and sorted, as the admin panel binds them. */
function blockEmailSet(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_EMAILS) return null;
  const out = new Set<string>();
  for (const value of raw) {
    const email = normalizeBlockEmail(value);
    if (!email) return null;
    out.add(email);
  }
  return [...out].sort();
}

export async function POST(request: NextRequest) {
  const cors = adminCorsHeaders(request.headers.get('origin'), METHODS);
  try {
    const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

    const body = await request.json().catch(() => null);
    const { phone, suspended, reason, stepUpId, emails } = (body ?? {}) as Record<string, unknown>;
    if (emails !== undefined) {
      return await setCustomerBlock(request, admin, { phone, suspended, reason, stepUpId, emails }, cors);
    }

    if (typeof phone !== 'string' || canonicalCustomerPhone(phone) !== phone) {
      return NextResponse.json({ error: 'phone must be the canonical number (country code and digits only)' }, { status: 400, headers: cors });
    }
    if (typeof suspended !== 'boolean') {
      return NextResponse.json({ error: 'suspended (boolean) is required' }, { status: 400, headers: cors });
    }
    if (reason !== undefined && reason !== null && typeof reason !== 'string') {
      return NextResponse.json({ error: 'reason must be text' }, { status: 400, headers: cors });
    }
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    if (trimmed.length > 500 || (suspended && trimmed.length < 3)) {
      return NextResponse.json({ error: suspended ? 'A reason (3 to 500 characters) is required' : 'reason is too long' }, { status: 400, headers: cors });
    }

    // The step-up is bound to exactly what the admin confirmed.
    try {
      await consumeStepUp(admin, typeof stepUpId === 'string' ? stepUpId : '', 'customer_suspension', phone, {
        phone, suspended, reason: (reason as string | null | undefined) ?? null,
      });
    } catch (err) {
      const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
      return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403, headers: cors });
    }

    const { data, error } = await createServiceClient().rpc('svc_set_customer_suspension', {
      p_actor_id: admin.userId,
      p_phone: phone,
      p_suspend: suspended,
      p_reason: trimmed || null,
      p_ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
    });
    if (error || !data) {
      return NextResponse.json({ error: 'Unable to save the suspension' }, { status: 500, headers: cors });
    }
    if (data.changed !== true) {
      return NextResponse.json({
        error: suspended ? 'This number is already suspended' : 'This number is not suspended',
        suspended: data.suspended === true,
      }, { status: 409, headers: cors });
    }
    return NextResponse.json({ suspended, phone }, { headers: cors });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: cors });
  }
}

async function setCustomerBlock(
  request: NextRequest,
  admin: PlatformAdmin,
  input: Record<string, unknown>,
  cors: Record<string, string>,
) {
  const { phone, suspended, reason, stepUpId } = input;
  const emails = blockEmailSet(input.emails);
  if (!emails) {
    return NextResponse.json({ error: `emails must be a list of up to ${MAX_EMAILS} valid email addresses` }, { status: 400, headers: cors });
  }
  if (phone !== null && (typeof phone !== 'string' || canonicalCustomerPhone(phone) !== phone)) {
    return NextResponse.json({ error: 'phone must be the canonical number (country code and digits only) or null' }, { status: 400, headers: cors });
  }
  if (phone === null && emails.length === 0) {
    return NextResponse.json({ error: 'Choose a number or at least one email' }, { status: 400, headers: cors });
  }
  if (typeof suspended !== 'boolean') {
    return NextResponse.json({ error: 'suspended (boolean) is required' }, { status: 400, headers: cors });
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return NextResponse.json({ error: 'reason must be text' }, { status: 400, headers: cors });
  }
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (trimmed.length > 500 || (suspended && trimmed.length < 3)) {
    return NextResponse.json({ error: suspended ? 'A reason (3 to 500 characters) is required' : 'reason is too long' }, { status: 400, headers: cors });
  }

  // Bound to exactly the number, reason and set of emails the admin confirmed.
  try {
    await consumeStepUp(admin, typeof stepUpId === 'string' ? stepUpId : '', 'customer_suspension', phone ?? emails[0], {
      phone, suspended, reason: (reason as string | null | undefined) ?? null, emails,
    });
  } catch (err) {
    const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
    return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403, headers: cors });
  }

  const { data, error } = await createServiceClient().rpc('svc_set_customer_block', {
    p_actor_id: admin.userId,
    p_phone: phone,
    p_phone_action: phone === null ? null : suspended ? 'block' : 'unblock',
    p_block_emails: suspended ? emails : [],
    p_unblock_emails: suspended ? [] : emails,
    p_reason: trimmed || null,
    p_ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
  });
  const result = data as { phone: { changed: boolean } | null; emails: Array<{ email: string; changed: boolean }> } | null;
  if (error || !result || !Array.isArray(result.emails)) {
    return NextResponse.json({ error: 'Unable to save the change' }, { status: 500, headers: cors });
  }
  const phoneChanged = result.phone?.changed === true;
  const changedEmails = result.emails.filter(e => e.changed === true).map(e => e.email);
  if (!phoneChanged && changedEmails.length === 0) {
    return NextResponse.json({
      error: suspended ? 'Already blocked' : 'Not blocked',
      suspended,
    }, { status: 409, headers: cors });
  }
  return NextResponse.json({ suspended, phone, phoneChanged, emails: changedEmails }, { headers: cors });
}
