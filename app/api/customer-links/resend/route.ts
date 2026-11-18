/**
 * POST /api/customer-links/resend — merchant resends a customer's ticket or
 * confirmation link by email (Owner decision 2026-11-18). See lib/customer-links.ts.
 *
 * Body: { kind: 'ticket' | 'booking' | 'order', id: uuid, check?: true }
 *   check: true → returns { link, canEmail, reason, emailHint } and sends nothing.
 *   otherwise   → emails the link to the customer (rate-limited per record).
 *
 * Only the signed-in owner of the record's business may use it. A record of
 * another business answers 404, the same as a missing one.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { readJsonObject, UUID_RE } from '@/lib/admin-route';
import {
  emailBlockedReason, isCustomerLinkKind, loadCustomerLinkTarget, maskEmail, resendCustomerLink,
} from '@/lib/customer-links';

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;
  const { user, service } = auth;

  const body = await readJsonObject(request);
  const kind = body?.kind;
  const id = body?.id;
  if (!isCustomerLinkKind(kind) || typeof id !== 'string' || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const target = await loadCustomerLinkTarget(service, kind, id);
  if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data: owned } = await service.from('businesses').select('id')
    .eq('id', target.businessId).eq('owner_id', user.id).maybeSingle();
  if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (body?.check === true) {
    const reason = emailBlockedReason(target);
    return NextResponse.json({
      link: target.url,
      canEmail: reason === null,
      reason,
      emailHint: target.email ? maskEmail(target.email) : null,
    });
  }

  const result = await resendCustomerLink(target);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ sent: true, sentTo: result.sentTo });
}
