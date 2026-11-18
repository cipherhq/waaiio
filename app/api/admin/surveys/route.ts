/**
 * GET /api/admin/surveys — surveys for the admin Surveys page (#1108 X3).
 * GET /api/admin/surveys?survey_id=<uuid> — that survey's latest 100 responses.
 *
 * `surveys` has no admin read policy and `survey_responses` has no SELECT grant
 * for `authenticated`, so the browser reads came back empty or failed silently.
 */
import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminPreflight, adminResponder, businessNames, UUID_RE } from '@/lib/admin-route';

const METHODS = 'GET, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return adminPreflight(request, METHODS);
}

export async function GET(request: NextRequest) {
  const reply = adminResponder(request, METHODS);
  // Same roles that can open the Surveys page (admin/src/lib/permissions.ts).
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'operations'] });
  if (!admin) return reply({ error: 'Unauthorized' }, 403);
  const service = createServiceClient();

  const surveyId = request.nextUrl.searchParams.get('survey_id');
  if (surveyId !== null) {
    if (!UUID_RE.test(surveyId)) return reply({ error: 'Invalid survey ID' }, 400);
    const { data, error } = await service.from('survey_responses')
      .select('id, survey_id, customer_phone, customer_name, answers, completed, started_at, completed_at')
      .eq('survey_id', surveyId)
      .order('started_at', { ascending: false })
      .limit(100);
    if (error) return reply({ error: 'Could not load survey responses' }, 500);
    return reply({ responses: data || [] });
  }

  const { data, error } = await service.from('surveys')
    .select('id, business_id, title, description, questions, status, total_responses, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) return reply({ error: 'Could not load surveys' }, 500);
  const rows = (data || []) as Array<{ business_id: string }>;
  const names = await businessNames(service, rows.map(r => r.business_id));
  return reply({ surveys: rows.map(r => ({ ...r, business_name: names.get(r.business_id) || 'Unknown' })) });
}
