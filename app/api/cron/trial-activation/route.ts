import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Deferred trial activation cron.
 *
 * Phase 1: Finds businesses with trial_ends_at IS NULL (not yet activated)
 * that have an active WhatsApp channel or wa_method = 'shared', and attempts
 * activate_trial_if_eligible for each.
 *
 * Phase 2: Legacy grandfather reconciliation. Finds businesses with
 * trial_ends_at > NOW() (active clock) but no trial_v2 grant (unresolved
 * grandfather rows from M372 migration). Calls reconcile_legacy_trial
 * to add the missing grant while preserving the original expiry.
 *
 * On pending results (missing config), inserts a deduped alert so the admin
 * dashboard can surface configuration issues.
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  let activated = 0;
  let pending = 0;
  let errors = 0;
  let reconciled = 0;

  try {
    // ── Phase 1: Fresh trial activation ──
    const { data: businesses, error: queryError } = await supabase
      .from('businesses')
      .select('id, name')
      .eq('subscription_tier', 'free')
      .eq('status', 'active')
      .is('trial_ends_at', null)
      .or('whatsapp_channel_id.not.is.null,wa_method.eq.shared')
      .limit(100);

    if (queryError) {
      console.error('[TRIAL-ACTIVATION-CRON] Query failed:', queryError);
      return NextResponse.json({ error: 'Query failed' }, { status: 500 });
    }

    for (const biz of (businesses || [])) {
      try {
        const { data: result, error: rpcError } = await supabase.rpc(
          'activate_trial_if_eligible',
          { p_business_id: biz.id },
        );

        if (rpcError) {
          console.error(`[TRIAL-ACTIVATION-CRON] RPC error for ${biz.id}:`, rpcError);
          errors++;
          continue;
        }

        const parsed = typeof result === 'string' ? JSON.parse(result) : result;

        if (parsed?.activated) {
          activated++;
        } else {
          pending++;
          const reason = parsed?.reason || 'unknown';

          if (
            reason === 'missing_trial_credit_config' ||
            reason === 'invalid_trial_days' ||
            reason === 'financial_gate_off'
          ) {
            await supabase.from('alerts').upsert(
              {
                business_id: biz.id,
                type: 'trial_config_missing',
                severity: 'warning',
                title: 'Trial activation pending',
                message: `Trial could not be activated: ${reason}. Configure platform settings to resolve.`,
                metadata: { reason, cron_run: new Date().toISOString() },
              },
              { onConflict: 'business_id,type', ignoreDuplicates: true },
            );
          }
        }
      } catch (err) {
        console.error(`[TRIAL-ACTIVATION-CRON] Error for ${biz.id}:`, err);
        errors++;
      }
    }

    // ── Phase 2: Legacy grandfather reconciliation ──
    // Find active legacy trials (clock set, still valid) without a trial_v2 grant.
    // These are unresolved grandfather rows from M372 migration.
    const { data: legacyRows, error: legacyError } = await supabase
      .rpc('find_unreconciled_legacy_trials');

    if (legacyError) {
      console.warn('[TRIAL-ACTIVATION-CRON] Legacy query failed (non-fatal):', legacyError);
    } else if (legacyRows && Array.isArray(legacyRows)) {
      for (const row of legacyRows) {
        try {
          const { data: result, error: rpcError } = await supabase.rpc(
            'reconcile_legacy_trial',
            { p_business_id: row.id },
          );

          if (rpcError) {
            console.error(`[TRIAL-ACTIVATION-CRON] Legacy reconcile error for ${row.id}:`, rpcError);
            errors++;
            continue;
          }

          const parsed = typeof result === 'string' ? JSON.parse(result) : result;
          if (parsed?.reconciled) {
            reconciled++;
          } else {
            pending++;
          }
        } catch (err) {
          console.error(`[TRIAL-ACTIVATION-CRON] Legacy error for ${row.id}:`, err);
          errors++;
        }
      }
    }

    return NextResponse.json({
      activated, pending, errors, reconciled,
      total: (businesses?.length || 0),
    });
  } catch (err) {
    console.error('[TRIAL-ACTIVATION-CRON] Unexpected error:', err);
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 });
  }
}
