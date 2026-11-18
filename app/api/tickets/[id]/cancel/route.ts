/**
 * POST /api/tickets/[id]/cancel — merchant cancels one valid event ticket
 * (Owner decision 2026-11-18: "Yes, fix it too").
 *
 * Status change only, exactly what the dashboard Tickets "Cancel Ticket" button
 * intends: no refund, payment, booking or seat-count change. The browser client
 * has no UPDATE right on event_tickets, so the old direct write changed nothing.
 * Only the signed-in owner or an active team member of the ticket's business
 * may cancel; any other caller gets 404, the same as a missing ticket.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { resolveBusinessRole } from '@/lib/capabilities/resolve-role';
import { UUID_RE } from '@/lib/admin-route';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;
  const { user, service } = auth;

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid ticket ID' }, { status: 400 });

  const { data: ticket, error: readError } = await service.from('event_tickets')
    .select('id, business_id, status').eq('id', id).maybeSingle();
  if (readError) return NextResponse.json({ error: 'Failed to cancel ticket' }, { status: 500 });
  if (!ticket) return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });

  const role = await resolveBusinessRole(service, ticket.business_id, user.id);
  if (!role.ok) return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });

  // Conditional update: only a still-valid ticket is cancelled.
  const { data: saved, error } = await service.from('event_tickets').update({ status: 'cancelled' })
    .eq('id', id).eq('business_id', ticket.business_id).eq('status', 'valid')
    .select('id, status').maybeSingle();
  if (error) return NextResponse.json({ error: 'Failed to cancel ticket' }, { status: 500 });
  if (!saved) {
    const { data: current } = await service.from('event_tickets').select('status').eq('id', id).maybeSingle();
    const status = current?.status || ticket.status;
    return NextResponse.json({ error: `Ticket is ${status}, so it was not cancelled.`, status }, { status: 409 });
  }
  return NextResponse.json({ ticket: { id: saved.id, status: saved.status } });
}
