import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

async function requireAdminOrFinance(supabase: ReturnType<typeof createServiceClient>) {
  // Use the SSR client for auth, then check role
  const supa = await createClient();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supa
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !['admin', 'finance'].includes(profile.role)) return null;
  return { user, role: profile.role as string };
}

export async function GET(request: NextRequest) {
  try {
    const service = createServiceClient();
    const auth = await requireAdminOrFinance(service);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const params = request.nextUrl.searchParams;
    const status = params.get('status');
    const resellerId = params.get('reseller_id');

    let query = service
      .from('reseller_payouts')
      .select('*, resellers!inner(company_name)', { count: 'exact' })
      .order('period_end', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }
    if (resellerId) {
      query = query.eq('reseller_id', resellerId);
    }

    const { data, count, error } = await query;

    if (error) {
      logger.error('[ADMIN_RESELLER_PAYOUTS] Fetch error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch payouts' }, { status: 500 });
    }

    const payouts = (data || []).map((p: any) => ({
      id: p.id,
      reseller_id: p.reseller_id,
      company_name: p.resellers?.company_name || 'Unknown',
      period_start: p.period_start,
      period_end: p.period_end,
      gross_commission: p.gross_commission,
      holdback: p.holdback,
      deductions: p.deductions,
      net_amount: p.net_amount,
      currency: p.currency,
      status: p.status,
      approved_by: p.approved_by,
      paid_at: p.paid_at,
      notes: p.notes,
      created_at: p.created_at,
    }));

    return NextResponse.json({ payouts, count: count ?? 0 });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const service = createServiceClient();
    const auth = await requireAdminOrFinance(service);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { reseller_id, period_start, period_end, holdback_percent, deductions, notes } = body;

    if (!reseller_id || !period_start || !period_end) {
      return NextResponse.json({ error: 'reseller_id, period_start, and period_end are required' }, { status: 400 });
    }

    // Validate date order
    if (period_start >= period_end) {
      return NextResponse.json({ error: 'period_start must be before period_end' }, { status: 400 });
    }

    // Validate input bounds
    if (holdback_percent !== undefined && holdback_percent !== null) {
      const hp = Number(holdback_percent);
      if (isNaN(hp) || hp < 0 || hp > 100) {
        return NextResponse.json({ error: 'holdback_percent must be between 0 and 100' }, { status: 400 });
      }
    }
    if (deductions !== undefined && deductions !== null) {
      const d = Number(deductions);
      if (isNaN(d) || d < 0) {
        return NextResponse.json({ error: 'deductions must be non-negative' }, { status: 400 });
      }
    }

    // Validate reseller exists
    const { data: reseller, error: resellerErr } = await service
      .from('resellers')
      .select('id, created_at, currency')
      .eq('id', reseller_id)
      .maybeSingle();

    if (resellerErr || !reseller) {
      return NextResponse.json({ error: 'Reseller not found' }, { status: 404 });
    }

    // Check for overlapping payout periods (not just exact duplicates)
    // A period overlaps if: existing.start < new.end AND existing.end > new.start
    const { data: overlapping } = await service
      .from('reseller_payouts')
      .select('id, period_start, period_end, status')
      .eq('reseller_id', reseller_id)
      .lt('period_start', period_end)
      .gt('period_end', period_start)
      .not('status', 'eq', 'rejected')
      .limit(1);

    if (overlapping && overlapping.length > 0) {
      return NextResponse.json({
        error: `Overlapping payout exists for ${overlapping[0].period_start} to ${overlapping[0].period_end}`,
      }, { status: 409 });
    }

    // Calculate gross commission from platform_fees
    // Uses gte(start) + lt(end) for consistency with overlap detection (exclusive end)
    const { data: fees, error: feesErr } = await service
      .from('platform_fees')
      .select('reseller_commission')
      .eq('reseller_id', reseller_id)
      .gte('created_at', period_start)
      .lt('created_at', period_end);

    if (feesErr) {
      logger.error('[ADMIN_RESELLER_PAYOUTS] Fee calc error:', feesErr.message);
      return NextResponse.json({ error: 'Failed to calculate commission' }, { status: 500 });
    }

    const grossCommission = (fees || []).reduce((sum, f) => sum + (f.reseller_commission || 0), 0);

    // Determine holdback percentage
    // Default: 10% if reseller created less than 90 days ago, 0% otherwise
    let effectiveHoldbackPercent: number;
    if (holdback_percent !== undefined && holdback_percent !== null) {
      effectiveHoldbackPercent = Number(holdback_percent);
    } else {
      const daysSinceCreation = Math.floor(
        (Date.now() - new Date(reseller.created_at).getTime()) / (1000 * 60 * 60 * 24)
      );
      effectiveHoldbackPercent = daysSinceCreation < 90 ? 10 : 0;
    }

    const holdback = Math.round(grossCommission * (effectiveHoldbackPercent / 100));
    const effectiveDeductions = Number(deductions) || 0;
    const netAmount = Math.max(0, grossCommission - holdback - effectiveDeductions);

    if (netAmount <= 0) {
      return NextResponse.json({ error: 'Net amount is zero or negative after holdback and deductions' }, { status: 400 });
    }

    const { data: payout, error: insertErr } = await service
      .from('reseller_payouts')
      .insert({
        reseller_id,
        period_start,
        period_end,
        gross_commission: grossCommission,
        holdback,
        deductions: effectiveDeductions,
        net_amount: netAmount,
        currency: reseller.currency || 'USD',
        status: 'pending',
        notes: notes || null,
        metadata: {
          holdback_percent: effectiveHoldbackPercent,
          fee_count: (fees || []).length,
          generated_by: auth.user.id,
        },
      })
      .select()
      .single();

    if (insertErr) {
      logger.error('[ADMIN_RESELLER_PAYOUTS] Insert error:', insertErr.message);
      return NextResponse.json({ error: 'Failed to create payout' }, { status: 500 });
    }

    logger.info(`[ADMIN_RESELLER_PAYOUTS] Payout created: ${payout.id} for reseller ${reseller_id}, net=${netAmount}`);

    // Mandatory audit — failure deletes the payout
    const { error: auditErr } = await service.from('admin_audit_logs').insert({
      actor_id: auth.user.id,
      action: 'reseller_payout_created',
      entity_type: 'reseller_payout',
      entity_id: payout.id,
      details: {
        reseller_id,
        period_start,
        period_end,
        gross_commission: grossCommission,
        net_amount: netAmount,
      },
    });
    if (auditErr) {
      await service.from('reseller_payouts').delete().eq('id', payout.id);
      logger.error('[RESELLER-PAYOUT] Audit failed, deleted payout:', auditErr.message);
      return NextResponse.json({ error: 'Audit logging failed — payout reverted' }, { status: 500 });
    }

    return NextResponse.json({ payout }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
