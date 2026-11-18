/**
 * POST /api/admin/tickets/[id]/cancel — mark one valid event ticket cancelled
 * (#1108 X2).
 *
 * Status change only, exactly what the admin Tickets page intends: no refund,
 * payment, booking or seat-count change. The browser client has no admin
 * UPDATE policy on event_tickets, so the old cancel matched 0 rows.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logAdminAudit } from '@/lib/admin-audit';
import { adminPreflight, adminRequestIp, adminResponder, UUID_RE } from '@/lib/admin-route';

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const reply = adminResponder(request);
  // Same roles that can open the Tickets page (admin/src/lib/permissions.ts).
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'support', 'operations'] });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const { id } = await params;
  if (!UUID_RE.test(id)) return reply({ error: 'Invalid ticket ID' }, 400);

  const service = createServiceClient();
  const { data: saved, error } = await service.from('event_tickets').update({ status: 'cancelled' })
    .eq('id', id).eq('status', 'valid').select('id, status, ticket_code, event_id, business_id').maybeSingle();
  if (error) return reply({ error: 'Failed to cancel ticket' }, 500);
  if (!saved) {
    const { data: current, error: readError } = await service.from('event_tickets').select('id, status').eq('id', id).maybeSingle();
    if (readError) return reply({ error: 'Could not confirm the ticket. Refresh and check its status.' }, 500);
    if (!current) return reply({ error: 'Ticket not found' }, 404);
    return reply({ error: `Ticket is ${current.status}, so it was not cancelled.`, status: current.status }, 409);
  }

  const audit = await logAdminAudit({
    actorId: admin.userId, action: 'cancel_ticket', entityType: 'event_ticket', entityId: id,
    details: { ticket_code: saved.ticket_code, event_id: saved.event_id, business_id: saved.business_id, previous_status: 'valid' },
    ipAddress: adminRequestIp(request),
  });
  return reply({ ticket: { id: saved.id, status: saved.status }, auditRecorded: !audit.error });
}
