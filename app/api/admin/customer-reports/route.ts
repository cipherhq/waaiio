/**
 * GET /api/admin/customer-reports — shared documents for the admin Reports
 * page (#1108 X3). `authenticated` has no SELECT grant on customer_reports,
 * so the browser read failed and the page showed an empty list.
 *
 * The document access token and file URL are not returned.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminPreflight, adminResponder, businessNames } from '@/lib/admin-route';

const METHODS = 'GET, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request, METHODS);
}

export async function GET(request: NextRequest) {
  const reply = adminResponder(request, METHODS);
  // Same roles that can open the Reports page (admin/src/lib/permissions.ts).
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'operations'] });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const service = createServiceClient();
  const { data, error } = await service.from('customer_reports')
    .select('id, business_id, customer_phone, customer_name, title, status, sent_at, created_at')
    .order('created_at', { ascending: false }).limit(1000);
  if (error) return reply({ error: 'Could not load reports' }, 500);
  const rows = (data || []) as Array<{ business_id: string }>;
  const names = await businessNames(service, rows.map(r => r.business_id));
  return reply({ reports: rows.map(r => ({ ...r, business_name: names.get(r.business_id) || 'Unknown' })) });
}
