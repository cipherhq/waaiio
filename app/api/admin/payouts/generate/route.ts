import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { loadPlatformSettings } from '@/lib/platformSettings';
import { logAdminAudit } from '@/lib/admin-audit';
import { getPayableFeeRows } from '@/lib/payments/payable-fees';

interface Flag {
  type: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  adjustment_ids?: string[];
}

export async function POST(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const body = await request.json();

  // SEC-005 Layer 4: Consume operation-bound step-up authorization
  try {
    await consumeStepUp(admin, body.stepUpId, 'payout_generate', null, { action: 'generate' });
  } catch (err) {
    const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
    return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403 });
  }

  const supabase = createServiceClient();

  try {
    const settings = await loadPlatformSettings({ useServiceClient: true });
    const COOLING_PERIOD_DAYS = settings.payout_cooling_period_days;
    const VELOCITY_THRESHOLD = settings.fraud_velocity_threshold;
    const MINIMUM_PAYOUT = settings.minimum_payout;

    // Calculate period: last full week (Monday to Sunday)
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() - periodEnd.getDay()); // Last Sunday
    const periodStart = new Date(periodEnd);
    periodStart.setDate(periodStart.getDate() - 6); // Monday before

    const periodStartStr = periodStart.toISOString().split('T')[0];
    const periodEndStr = periodEnd.toISOString().split('T')[0];

    // Get all active platform-managed businesses with verification info
    const { data: businesses, error: bizError } = await supabase
      .from('businesses')
      .select('id, created_at, verification_level, payout_limit_monthly, country_code')
      .eq('payout_mode', 'platform_managed')
      .eq('status', 'active');

    if (bizError) {
      return NextResponse.json({ error: 'Failed to load businesses' }, { status: 500 });
    }

    if (!businesses?.length) {
      return NextResponse.json({ success: true, created: 0, skipped: 0, held: 0, message: 'No platform-managed businesses' });
    }

    let created = 0;
    let skipped = 0;
    let held = 0;
    let failed = 0;
    const needsAttention: string[] = [];

    for (const biz of businesses) {
      // Check if payout already exists for this period
      const { data: existing, error: existingError } = await supabase
        .from('business_payouts')
        .select('id')
        .eq('business_id', biz.id)
        .eq('period_start', periodStartStr)
        .eq('period_end', periodEndStr)
        .maybeSingle();

      // Fail closed: if we can't check for duplicates, count as failed
      if (existingError) {
        logger.error('[PAYOUT] Dedup check failed for business', { business_id: biz.id, error: existingError.message });
        failed++;
        continue;
      }
      if (existing) continue;

      // Get platform fees for this period (authoritative source for transaction amounts and fees)
      // Exclude direct transfers — Waaiio never holds those funds (money goes straight to business bank account)
      const { data: fees, error: feesError } = await supabase
        .from('platform_fees')
        .select('transaction_amount, fee_total, gateway_fee, waived, is_direct_transfer')
        .eq('business_id', biz.id)
        .is('refunded_at', null)
        .gte('created_at', periodStart.toISOString())
        .lte('created_at', periodEnd.toISOString());

      // Fail closed: if fee data is unavailable, count as failed (never generate with partial data)
      if (feesError) {
        logger.error('[PAYOUT] Fee query failed for business', { business_id: biz.id, error: feesError.message });
        failed++;
        continue;
      }

      // Gross from platform_fees.transaction_amount — only gateway payments (Waaiio holds these funds)
      // Direct transfers are excluded: business already has the money, we only invoice the platform fee
      const gatewayFees = getPayableFeeRows(fees || []);
      const gross = gatewayFees.reduce((s, f) => s + Number(f.transaction_amount || 0), 0);
      if (gross <= 0) continue;

      const totalFees = gatewayFees.filter(f => !f.waived).reduce((s, f) => s + Number(f.fee_total || 0), 0);
      const totalGatewayFees = gatewayFees.reduce((s, f) => s + Number(f.gateway_fee || 0), 0);

      // Still fetch payments for velocity check below
      const { data: payments, error: paymentsError } = await supabase
        .from('payments')
        .select('created_at')
        .eq('business_id', biz.id)
        .eq('status', 'success')
        .gte('created_at', periodStart.toISOString())
        .lte('created_at', periodEnd.toISOString());

      if (paymentsError) {
        logger.error('[PAYOUT] Payments query failed for business', { business_id: biz.id, error: paymentsError.message });
        failed++;
        continue;
      }

      // Deduct any unapplied payout adjustments (e.g. post-payout refunds)
      const { data: adjustments, error: adjQueryError } = await supabase
        .from('payout_adjustments')
        .select('id, amount')
        .eq('business_id', biz.id)
        .is('applied_to_payout_id', null);

      if (adjQueryError) {
        logger.error('[PAYOUT] Adjustments query failed for business', { business_id: biz.id, error: adjQueryError.message });
        failed++;
        continue;
      }

      const totalAdjustments = (adjustments || []).reduce((s, a) => s + Number(a.amount || 0), 0);
      const net = Math.max(0, gross - totalFees - totalGatewayFees + totalAdjustments);

      // Minimum payout threshold — skip if amount too small
      const minPayout = MINIMUM_PAYOUT[biz.country_code || 'NG'] || 5000;
      if (net < minPayout) {
        skipped++;
        continue;
      }

      // Build flags
      const flags: Flag[] = [];
      let status = 'pending';

      // --- COOLING PERIOD CHECK ---
      const bizCreatedAt = new Date(biz.created_at);
      const daysSinceCreation = Math.floor((now.getTime() - bizCreatedAt.getTime()) / (1000 * 60 * 60 * 24));
      if (daysSinceCreation < COOLING_PERIOD_DAYS) {
        flags.push({
          type: 'cooling_period',
          message: `Business created ${daysSinceCreation} days ago (< ${COOLING_PERIOD_DAYS} day cooling period)`,
          severity: 'warning',
        });
        status = 'held';
      }

      // --- VERIFICATION CHECK ---
      const verLevel = biz.verification_level || 'unverified';
      if (verLevel === 'unverified') {
        flags.push({
          type: 'unverified',
          message: 'Business is unverified — payouts are not allowed',
          severity: 'critical',
        });
        status = 'held';
      }

      // --- PAYOUT LIMIT CHECK ---
      const monthlyLimit = Number(biz.payout_limit_monthly || 0);
      if (monthlyLimit > 0 && monthlyLimit < 999999999) {
        // Check total payouts this month
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const { data: monthPayouts } = await supabase
          .from('business_payouts')
          .select('net_amount')
          .eq('business_id', biz.id)
          .in('status', ['pending', 'approved', 'processing', 'paid'])
          .gte('created_at', monthStart);

        const monthTotal = (monthPayouts || []).reduce((s, p) => s + Number(p.net_amount || 0), 0);
        if (monthTotal + net > monthlyLimit) {
          flags.push({
            type: 'over_limit',
            message: `Monthly total (${monthTotal + net}) exceeds limit (${monthlyLimit})`,
            severity: 'warning',
          });
          status = 'held';
        }
      }

      // --- VELOCITY CHECK ---
      // Count max transactions in any single day during the period
      const dailyCounts: Record<string, number> = {};
      for (const p of payments || []) {
        const day = new Date(p.created_at).toISOString().split('T')[0];
        dailyCounts[day] = (dailyCounts[day] || 0) + 1;
      }
      const maxDaily = Math.max(0, ...Object.values(dailyCounts));
      if (maxDaily > VELOCITY_THRESHOLD) {
        flags.push({
          type: 'high_velocity',
          message: `${maxDaily} transactions in a single day (threshold: ${VELOCITY_THRESHOLD})`,
          severity: 'warning',
        });
        // Don't auto-hold for velocity, just flag for review
      }

      // --- LARGE PAYOUT CHECK ---
      const LARGE_PAYOUT_THRESHOLD = 1_000_000;
      if (net >= LARGE_PAYOUT_THRESHOLD) {
        flags.push({
          type: 'large_payout',
          message: `Net payout amount (${net.toLocaleString()}) exceeds ${LARGE_PAYOUT_THRESHOLD.toLocaleString()} — review carefully`,
          severity: 'warning',
        });
        // Informational flag only — does not auto-hold
      }

      // Get active payout account
      const { data: payoutAccount } = await supabase
        .from('payout_accounts')
        .select('id')
        .eq('business_id', biz.id)
        .eq('is_active', true)
        .maybeSingle();

      // SEC-005: INSERT uses service client — authenticated DML revoked on business_payouts.
      if (adjustments && adjustments.length > 0) {
        // --- Adjustment-linked payout: INSERT held → link → promote ---
        const adjIds = [...new Set(adjustments.map(a => a.id))];
        const intendedStatus = status; // remember the computed status

        const insertFlags: Flag[] = [...flags, {
          type: 'adjustment_link_pending',
          message: `Linking ${adjIds.length} adjustment(s)`,
          severity: 'critical',
          adjustment_ids: adjIds,
        }];

        // Step 1: INSERT as held with adjustment_link_pending flag
        const { data: payout, error: insertError } = await supabase.from('business_payouts').insert({
          business_id: biz.id,
          payout_account_id: payoutAccount?.id || null,
          period_start: periodStartStr,
          period_end: periodEndStr,
          gross_amount: gross,
          platform_fee: totalFees,
          gateway_fee: totalGatewayFees,
          net_amount: net,
          status: 'held',
          flags: insertFlags,
        }).select('id').single();

        if (insertError || !payout) {
          // Unique violation (23505) or any insert error: nothing linked, safe to skip
          logger.error('[PAYOUT] Failed to insert payout for business', {
            business_id: biz.id, error: insertError?.message, code: insertError?.code,
          });
          failed++;
          continue;
        }

        // Step 2: Link adjustments with CAS (only unlinked)
        const { data: linkedRows, error: linkError } = await supabase
          .from('payout_adjustments')
          .update({ applied_to_payout_id: payout.id })
          .in('id', adjIds)
          .is('applied_to_payout_id', null) // CAS: only unlinked
          .select('id');

        const linkedIds = (linkedRows || []).map(r => r.id);
        const linkedSet = new Set(linkedIds);
        const expectedSet = new Set(adjIds);
        const linkSuccess = !linkError
          && linkedSet.size === expectedSet.size
          && adjIds.every(id => linkedSet.has(id));

        if (linkSuccess) {
          // Step 3: Promote with CAS — remove the pending flag
          const { data: promoteResult, error: promoteError } = await supabase
            .from('business_payouts')
            .update({ status: intendedStatus, flags })
            .eq('id', payout.id)
            .eq('status', 'held')
            .contains('flags', [{ type: 'adjustment_link_pending' }])
            .select('id');

          if (promoteError || !promoteResult || promoteResult.length !== 1) {
            // Promote failed — re-read to understand state
            const { data: reread } = await supabase
              .from('business_payouts')
              .select('id, status, flags')
              .eq('id', payout.id)
              .single();
            logger.error('[PAYOUT] Promote CAS failed after successful link', {
              payout_id: payout.id, business_id: biz.id,
              promote_error: promoteError?.message,
              persisted_status: reread?.status,
              persisted_flags: reread?.flags,
            });
            needsAttention.push(payout.id);
            failed++;
            continue;
          }

          // Promote succeeded
          if (intendedStatus === 'held') {
            held++;
          } else {
            created++;
          }
        } else {
          // Step 4: Link failed — swap pending flag with failed flag
          const reason = linkError
            ? `Link error: ${linkError.message}`
            : `Linked ${linkedSet.size}/${expectedSet.size} adjustment(s) — set mismatch`;

          const failedFlags: Flag[] = flags.filter(f => f.type !== 'adjustment_link_pending');
          failedFlags.push({
            type: 'adjustment_link_failed',
            message: reason,
            severity: 'critical',
            adjustment_ids: adjIds,
          });

          const { data: swapResult, error: swapError } = await supabase
            .from('business_payouts')
            .update({ status: 'held', flags: failedFlags })
            .eq('id', payout.id)
            .select('id');

          if (swapError || !swapResult || swapResult.length === 0) {
            // Swap failed — payout stays held+pending (still blocked)
            logger.error('[PAYOUT] Flag swap failed — payout stays held+pending', {
              payout_id: payout.id, business_id: biz.id, adjIds,
              swap_error: swapError?.message,
            });
            needsAttention.push(payout.id);
          } else {
            logger.error('[PAYOUT] Adjustment link failed — payout held with failed flag', {
              payout_id: payout.id, business_id: biz.id, adjIds, reason,
            });
          }
          failed++;
          continue;
        }
      } else {
        // --- No adjustments: INSERT with computed status and flags ---
        const { data: newPayout, error: insertError } = await supabase.from('business_payouts').insert({
          business_id: biz.id,
          payout_account_id: payoutAccount?.id || null,
          period_start: periodStartStr,
          period_end: periodEndStr,
          gross_amount: gross,
          platform_fee: totalFees,
          gateway_fee: totalGatewayFees,
          net_amount: net,
          status,
          flags,
        }).select('id').single();

        if (insertError || !newPayout) {
          logger.error('[PAYOUT] Failed to insert payout for business', {
            business_id: biz.id, error: insertError?.message,
          });
          failed++;
          continue;
        }

        if (status === 'held') {
          held++;
        } else {
          created++;
        }
      }
    }

    // Audit log — uses service client (INSERT revoked from authenticated)
    await logAdminAudit({
      actorId: admin.id,
      action: 'generate_payouts',
      entityType: 'business_payout',
      entityId: null,
      details: {
        period_start: periodStartStr,
        period_end: periodEndStr,
        businesses_checked: businesses.length,
        payouts_created: created,
        payouts_held: held,
        payouts_failed: failed,
        needs_attention: needsAttention,
      },
    });

    // Never report success when any INSERT failed
    if (failed > 0) {
      return NextResponse.json({
        error: `Payout generation completed with ${failed} failed write(s)`,
        created,
        held,
        skipped,
        needs_attention: needsAttention.length > 0 ? needsAttention : undefined,
        failed,
        period: { start: periodStartStr, end: periodEndStr },
      }, { status: 207 });
    }

    if (created === 0 && held === 0) {
      return NextResponse.json({
        success: true,
        created: 0,
        held: 0,
        skipped,
        failed: 0,
        period: { start: periodStartStr, end: periodEndStr },
        message: 'No eligible payouts for this period',
      });
    }

    return NextResponse.json({
      success: true,
      created,
      held,
      skipped,
      failed: 0,
      period: { start: periodStartStr, end: periodEndStr },
    });
  } catch (error) {
    logger.withContext({ op: 'payout.generate', ...safeLogErrorContext(error) })
      .error('[PAYOUT] Generate failed');
    return NextResponse.json({ error: 'Failed to generate payouts' }, { status: 500 });
  }
}
