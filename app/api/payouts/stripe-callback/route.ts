import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { consumeState } from '@/lib/oauth-connect-state';
import { sendEmail } from '@/lib/email/client';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';

export async function GET(request: NextRequest) {
  if (process.env.ENABLE_STRIPE_CONNECT !== 'true') {
    return NextResponse.json({ error: 'Stripe Connect is currently disabled' }, { status: 503 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  const { searchParams } = new URL(request.url);
  const stateRaw = searchParams.get('state');
  const stripeAccountId = searchParams.get('stripe_account');

  if (!stateRaw || !stripeAccountId) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=missing_params`);
  }

  if (!stripeSecretKey) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_configured`);
  }

  // Require authenticated user
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_authenticated`);
  }

  const serviceClient = createServiceClient();

  // Consume state atomically — verifies user, provider, expiry, single-use
  const stateResult = await consumeState(serviceClient, {
    stateRaw,
    userId: user.id,
    provider: 'stripe',
  });
  if (!stateResult.ok || !stateResult.businessId) {
    logger.warn('[STRIPE-CALLBACK] State validation failed:', stateResult.error);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=invalid_state`);
  }

  const businessId = stateResult.businessId;

  // Re-check ownership (defense in depth)
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, name, owner_id')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    logger.warn('[STRIPE-CALLBACK] Ownership re-check failed for business', businessId);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_authorized`);
  }

  try {
    // Fetch the Stripe account and verify
    const res = await fetch(`https://api.stripe.com/v1/accounts/${encodeURIComponent(stripeAccountId)}`, {
      headers: { Authorization: `Bearer ${stripeSecretKey}` },
    });
    const account = await res.json();

    if (!account.charges_enabled) {
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_verified`);
    }

    // Verify the account was created for this business
    if (account.metadata?.business_id !== businessId) {
      logger.error('[STRIPE-CALLBACK] Metadata business_id mismatch', {
        expected: businessId,
        actual: account.metadata?.business_id,
      });
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=account_mismatch`);
    }

    // In production, require livemode
    const env = process.env.WAAIIO_ENVIRONMENT || process.env.VERCEL_ENV || 'development';
    if (env === 'production' && account.livemode !== true) {
      logger.error('[STRIPE-CALLBACK] livemode=false in production');
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=test_account`);
    }

    // Save via atomic RPC (service_role)
    const { data: newAccountId, error: rpcError } = await serviceClient.rpc('swap_payout_account', {
      p_business_id: businessId,
      p_gateway: 'stripe',
      p_stripe_account_id: stripeAccountId,
      p_verified_at: new Date().toISOString(),
    });

    if (rpcError) {
      logger.withContext({ op: 'stripe-callback.rpc', ...safeLogErrorContext(rpcError) }).error('[STRIPE-CALLBACK] RPC error');
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=save_failed`);
    }

    // Update business payout mode
    const { error: modeError } = await serviceClient
      .from('businesses')
      .update({ payout_mode: 'direct_split' })
      .eq('id', businessId);
    if (modeError) {
      const Sentry = await import('@sentry/nextjs');
      Sentry.captureException(modeError, { tags: { component: 'stripe-callback', operation: 'payout_mode_update' } });
      logger.error('[STRIPE-CALLBACK] payout_mode update failed:', modeError);
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=mode_update_failed`);
    }

    // Owner notification email (non-blocking)
    try {
      const { data: ownerProfile } = await serviceClient.from('profiles').select('email').eq('id', biz.owner_id).single();
      if (ownerProfile?.email) {
        await sendEmail({
          to: ownerProfile.email,
          subject: `Stripe payout account connected — ${biz.name}`,
          html: `<p>A Stripe payout account has been connected to <strong>${biz.name}</strong>.</p><p>If you did not do this, please contact support immediately.</p>`,
        });
      }
    } catch (emailErr) {
      logger.warn('[STRIPE-CALLBACK] Owner notification email failed (non-blocking):', emailErr);
    }

    return NextResponse.redirect(`${appUrl}/dashboard/payouts?connected=true`);
  } catch (error) {
    logger.withContext({ op: 'stripe-callback', ...safeLogErrorContext(error) })
      .error('[STRIPE-CALLBACK] Callback failed');
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=callback_failed`);
  }
}
