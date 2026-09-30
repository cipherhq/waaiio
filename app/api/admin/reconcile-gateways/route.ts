import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { adminCorsHeaders } from '@/lib/admin-cors';
// reconcileNullGateways kept in gateway-resolver.ts for programmatic use
// This endpoint uses bounded per-business CAS mutations instead

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

    // Bounded batch reconciliation
    const batchSize = Math.min(Math.max(body.batch_size || 25, 1), 100);
    const cursor = body.cursor as string | undefined; // business ID for deterministic ordering

    // Fetch bounded batch of NULL-gateway businesses
    let query = supabase
      .from('businesses')
      .select('id, name, country_code')
      .is('payment_gateway', null)
      .order('id', { ascending: true })
      .limit(batchSize);

    if (cursor) {
      query = query.gt('id', cursor);
    }

    const { data: batch } = await query;
    if (!batch || batch.length === 0) {
      return NextResponse.json({ dry_run: dryRun, updated: [], skipped: [], failed: [], next_cursor: null }, { headers: cors });
    }

    // Resolve country gateways for the batch
    const { data: countries } = await supabase
      .from('countries').select('code, payment_gateway').eq('is_active', true).not('payment_gateway', 'is', null);
    const countryMap = new Map((countries || []).map(c => [c.code, c.payment_gateway]));

    const wouldUpdate: Array<{ id: string; name: string; country_code: string; gateway: string }> = [];
    const skipped: Array<{ id: string; name: string; reason: string }> = [];

    for (const biz of batch) {
      const gw = countryMap.get(biz.country_code);
      if (gw) {
        wouldUpdate.push({ id: biz.id, name: biz.name, country_code: biz.country_code, gateway: gw });
      } else {
        skipped.push({ id: biz.id, name: biz.name, reason: 'no_country_gateway' });
      }
    }

    const nextCursor = batch.length === batchSize ? batch[batch.length - 1].id : null;

    if (dryRun) {
      return NextResponse.json({ dry_run: true, would_update: wouldUpdate, skipped, next_cursor: nextCursor }, { headers: cors });
    }

    // Execute bounded mutations — CAS: only NULL → canonical country processor
    const updated: Array<{ id: string; gateway: string }> = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const item of wouldUpdate) {
      const { data: rows, error: updateErr } = await supabase
        .from('businesses')
        .update({ payment_gateway: item.gateway })
        .eq('id', item.id)
        .is('payment_gateway', null)
        .select('id');

      if (updateErr) {
        failed.push({ id: item.id, error: updateErr.message });
      } else if (rows && rows.length > 0) {
        updated.push({ id: item.id, gateway: item.gateway });
      }
      // rows.length === 0 means CAS failed (already set) — idempotent, not an error
    }

    return NextResponse.json({ dry_run: false, updated, skipped, failed, next_cursor: nextCursor }, { headers: cors });
  } catch (err) {
    return NextResponse.json({ error: 'Internal error', detail: String(err) }, { status: 500, headers: cors });
  }
}
