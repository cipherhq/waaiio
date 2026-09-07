import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Deferred trial activation cron.
 *
 * Finds businesses with trial_ends_at IS NULL (not yet activated) that have
 * an active WhatsApp channel or wa_method = 'shared', and attempts
 * activate_trial_if_eligible for each.
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

  try {
    // Find businesses eligible for deferred trial activation:
    // - subscription_tier = 'free'
    // - trial_ends_at IS NULL (not yet activated)
    // - status = 'active' (completed onboarding)
    // - Has a channel (whatsapp_channel_id IS NOT NULL) OR wa_method = 'shared'
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

    if (!businesses || businesses.length === 0) {
      return NextResponse.json({ activated: 0, pending: 0, errors: 0 });
    }

    for (const biz of businesses) {
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
          // Pending: missing config, currency resolution failed, etc.
          pending++;
          const reason = parsed?.reason || 'unknown';

          // Insert deduped alert for admin visibility
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

    return NextResponse.json({ activated, pending, errors, total: businesses.length });
  } catch (err) {
    console.error('[TRIAL-ACTIVATION-CRON] Unexpected error:', err);
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 });
  }
}
