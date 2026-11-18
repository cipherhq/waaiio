/**
 * GET /api/admin/queue-entries?date=YYYY-MM-DD[&status=] — queue check-ins
 * for the admin Queue page (#1108 X3). `authenticated` has no SELECT grant on
 * queue_entries, so the browser read failed and the page showed nothing.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminPreflight, adminResponder, businessNames } from '@/lib/admin-route';

const METHODS = 'GET, OPTIONS';
// queue_entries.status CHECK (M018, widened by M316)
const STATUSES = new Set(['waiting', 'serving', 'completed', 'no_show', 'cancelled']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request, METHODS);
}

export async function GET(request: NextRequest) {
  const reply = adminResponder(request, METHODS);
  // Same roles that can open the Queue page (admin/src/lib/permissions.ts).
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'operations'] });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const date = request.nextUrl.searchParams.get('date');
  const status = request.nextUrl.searchParams.get('status');
  if (!date || !DATE_RE.test(date)) return reply({ error: 'Invalid date' }, 400);
  if (status !== null && !STATUSES.has(status)) return reply({ error: 'Invalid status' }, 400);

  const service = createServiceClient();
  let query = service.from('queue_entries')
    .select('id, business_id, customer_phone, customer_name, queue_number, queue_date, status, checked_in_at, called_at, completed_at, estimated_wait_minutes, channel, created_at')
    .eq('queue_date', date);
  if (status) query = query.eq('status', status);
  const { data, error } = await query.order('queue_number', { ascending: true }).limit(1000);
  if (error) return reply({ error: 'Could not load queue entries' }, 500);
  const rows = (data || []) as Array<{ business_id: string }>;
  const names = await businessNames(service, rows.map(r => r.business_id));
  return reply({ entries: rows.map(r => ({ ...r, business_name: names.get(r.business_id) || 'Unknown' })) });
}
