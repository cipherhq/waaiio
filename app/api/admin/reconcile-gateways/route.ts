import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { adminCorsHeaders } from '@/lib/admin-cors';
import { reconcileNullGateways } from '@/lib/payments/gateway-resolver';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin')) });
}

/**
 * POST /api/admin/reconcile-gateways (#493 B4)
 *
 * Bounded admin endpoint: assign canonical country-default gateway
 * to businesses with NULL payment_gateway.
 *
 * Body: { dry_run?: boolean (default true), business_id?: string }
 *
 * Requires platform admin authorization.
 * Do NOT execute against staging without explicit Owner authorization.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  const cors = adminCorsHeaders(origin);

  const admin = await requirePlatformAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });
  }

  const supabase = createServiceClient();

  try {
    const body = await request.json();
    const dryRun = body.dry_run !== false;
    const businessId = body.business_id as string | undefined;

    if (businessId) {
      const { resolveBusinessGateway } = await import('@/lib/payments/gateway-resolver');
      const result = await resolveBusinessGateway(supabase, businessId);

      const { data: biz } = await supabase
        .from('businesses')
        .select('id, name, payment_gateway, country_code')
        .eq('id', businessId)
        .single();

      if (!biz) {
        return NextResponse.json({ error: 'Business not found' }, { status: 404, headers: cors });
      }
      if (biz.payment_gateway) {
        return NextResponse.json({
          dry_run: dryRun,
          message: 'Business already has a gateway assigned',
          business: { id: biz.id, name: biz.name, current_gateway: biz.payment_gateway },
        }, { headers: cors });
      }
      if (!result.gateway) {
        return NextResponse.json({
          dry_run: dryRun,
          message: 'No gateway available for this business',
          reason: (result as { reason?: string }).reason,
          business: { id: biz.id, name: biz.name, country_code: biz.country_code },
        }, { headers: cors });
      }

      if (dryRun) {
        return NextResponse.json({
          dry_run: true,
          would_update: [{ id: biz.id, name: biz.name, country_code: biz.country_code, resolved_gateway: result.gateway }],
        }, { headers: cors });
      }

      const { error: updateErr } = await supabase
        .from('businesses')
        .update({ payment_gateway: result.gateway })
        .eq('id', businessId)
        .is('payment_gateway', null);

      if (updateErr) {
        return NextResponse.json({ error: 'Update failed', detail: updateErr.message }, { status: 500, headers: cors });
      }

      return NextResponse.json({
        dry_run: false, updated: 1,
        business: { id: biz.id, name: biz.name, gateway: result.gateway },
      }, { headers: cors });
    }

    // Bulk reconciliation
    if (dryRun) {
      const { data: nullGatewayBiz } = await supabase
        .from('businesses').select('id, name, country_code').is('payment_gateway', null).limit(100);
      const { data: countries } = await supabase
        .from('countries').select('code, payment_gateway').eq('is_active', true).not('payment_gateway', 'is', null);

      const countryMap = new Map((countries || []).map(c => [c.code, c.payment_gateway]));
      const preview = (nullGatewayBiz || []).map(b => ({
        id: b.id, name: b.name, country_code: b.country_code,
        resolved_gateway: countryMap.get(b.country_code) || null,
      }));

      return NextResponse.json({
        dry_run: true,
        would_update: preview.filter(p => p.resolved_gateway),
        no_gateway_available: preview.filter(p => !p.resolved_gateway),
      }, { headers: cors });
    }

    const result = await reconcileNullGateways(supabase);
    return NextResponse.json({ dry_run: false, updated: result.updated, errors: result.errors }, { headers: cors });
  } catch (err) {
    return NextResponse.json({ error: 'Internal error', detail: String(err) }, { status: 500, headers: cors });
  }
}
