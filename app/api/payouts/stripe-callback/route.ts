import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

  // Validate cryptographic OAuth state
  const state = searchParams.get('state');
  if (!state) {
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=missing_state`);
  }

  const { verifyOAuthState, consumeOAuthState } = await import('@/lib/payments/oauth-state');
  const { createServiceClient } = await import('@/lib/supabase/service');
  const verified = verifyOAuthState(state);
  if (!verified) {
    logger.warn('[STRIPE-CALLBACK] Invalid, expired, or tampered state parameter');
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=invalid_state`);
  }

  // Consume nonce atomically — prevents replay
  const service = createServiceClient();
  const consumed = await consumeOAuthState(service, verified.nonce);
  if (!consumed) {
    logger.warn('[STRIPE-CALLBACK] State already consumed (replay attempt)');
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=state_replayed`);
  }

  const { userId, businessId, accountId } = verified;

  // Verify the authenticated user matches the state
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.id !== userId) {
    logger.warn('[STRIPE-CALLBACK] Authenticated user does not match state');
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=user_mismatch`);
  }

  try {
    if (!stripeSecretKey) {
      // Mock mode — deactivate only previous Stripe, preserve others
      await supabase.from('payout_accounts')
        .update({ is_active: false, connection_status: 'revoked', updated_at: new Date().toISOString() })
        .eq('business_id', businessId).eq('gateway', 'stripe').eq('is_active', true);

      const { data: mockDefault } = await supabase.from('payout_accounts')
        .select('id').eq('business_id', businessId).eq('is_default', true)
        .eq('is_active', true).not('verified_at', 'is', null).maybeSingle();

      await supabase.from('payout_accounts').insert({
        business_id: businessId, gateway: 'stripe', stripe_account_id: accountId,
        platform_percentage: 2.5, is_active: true, is_default: !mockDefault,
        connection_mode: 'connect', connection_status: 'active',
        health_status: 'healthy', verified_at: new Date().toISOString(),
      });

      return NextResponse.redirect(`${appUrl}/dashboard/payouts?connected=true`);
    }

    // Verify the account status
    const res = await fetch(`https://api.stripe.com/v1/accounts/${encodeURIComponent(accountId)}`, {
      headers: { Authorization: `Bearer ${stripeSecretKey}` },
    });
    const account = await res.json();

    if (!account.charges_enabled) {
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_verified`);
    }

    // Deactivate only previous Stripe connections (preserve other providers)
    await supabase
      .from('payout_accounts')
      .update({ is_active: false, connection_status: 'revoked', updated_at: new Date().toISOString() })
      .eq('business_id', businessId)
      .eq('gateway', 'stripe')
      .eq('is_active', true);

    // Check if business has an existing valid default
    const { data: existingDefault } = await supabase
      .from('payout_accounts')
      .select('id')
      .eq('business_id', businessId)
      .eq('is_default', true)
      .eq('is_active', true)
      .not('verified_at', 'is', null)
      .maybeSingle();

    // Save the connected account
    const { data: newConn, error: insertErr } = await supabase.from('payout_accounts').insert({
      business_id: businessId,
      gateway: 'stripe',
      stripe_account_id: accountId,
      platform_percentage: 2.5,
      is_active: true,
      is_default: !existingDefault, // Default only if no existing valid default
      connection_mode: 'connect',
      connection_status: 'active',
      health_status: 'healthy',
      verified_at: new Date().toISOString(),
    }).select('id').single();

    if (insertErr) {
      logger.error('[STRIPE-CALLBACK] Insert error:', insertErr.message);
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=insert_failed`);
    }

    // Auto-set payout_mode to direct_split when merchant connects Stripe
    await supabase
      .from('businesses')
      .update({ payout_mode: 'direct_split' })
      .eq('id', businessId);

    return NextResponse.redirect(`${appUrl}/dashboard/payouts?connected=true`);
  } catch (error) {
    logger.error('Stripe callback error:', (error as Error).message);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=callback_failed`);
  }
}
