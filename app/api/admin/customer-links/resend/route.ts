/**
 * POST /api/admin/customer-links/resend — admin resends a customer's ticket or
 * confirmation link by email (Owner decision 2026-11-18). See lib/customer-links.ts.
 *
 * Body: { kind: 'ticket' | 'booking' | 'order', id: uuid, check?: true }
 *   check: true → returns { link, canEmail, reason, emailHint } and sends nothing.
 *   otherwise   → emails the link (rate-limited per record) and writes an admin audit row.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logAdminAudit } from '@/lib/admin-audit';
import { adminPreflight, adminRequestIp, adminResponder, readJsonObject, UUID_RE } from '@/lib/admin-route';
import {
  emailBlockedReason, isCustomerLinkKind, loadCustomerLinkTarget, maskEmail, resendCustomerLink,
} from '@/lib/customer-links';

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request);
}

export async function POST(request: NextRequest) {
  const reply = adminResponder(request);
  // Same roles that can open the Tickets, Bookings and Orders pages (admin/src/lib/permissions.ts).
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'support', 'operations'] });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);

  const body = await readJsonObject(request);
  const kind = body?.kind;
  const id = body?.id;
  if (!isCustomerLinkKind(kind) || typeof id !== 'string' || !UUID_RE.test(id)) {
    return reply({ error: 'Invalid request' }, 400);
  }

  const service = createServiceClient();
  const target = await loadCustomerLinkTarget(service, kind, id);
  if (!target) return reply({ error: 'Not found' }, 404);

  if (body?.check === true) {
    const reason = emailBlockedReason(target);
    return reply({
      link: target.url,
      canEmail: reason === null,
      reason,
      emailHint: target.email ? maskEmail(target.email) : null,
    });
  }

  const result = await resendCustomerLink(target);
  if (!result.ok) return reply({ error: result.error }, result.status);

  const audit = await logAdminAudit({
    actorId: admin.userId, action: 'resend_customer_link', entityType: kind, entityId: id,
    details: { business_id: target.businessId, code: target.code, sent_to: result.sentTo },
    ipAddress: adminRequestIp(request),
  });
  return reply({ sent: true, sentTo: result.sentTo, auditRecorded: !audit.error });
}
