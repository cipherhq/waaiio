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

  // Consume nonce atomically — prevents replay.
  // Returns the stored state payload (from DB), not just a boolean.
  const service = createServiceClient();
  let consumed;
  try {
    consumed = await consumeOAuthState(service, verified.nonce);
  } catch (err) {
    logger.error('[STRIPE-CALLBACK] OAuth state consumption error:', (err as Error).message);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=state_error`);
  }
  if (!consumed) {
    logger.warn('[STRIPE-CALLBACK] State already consumed (replay attempt)');
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=state_replayed`);
  }

  // Use the DB-stored payload (authoritative), not just the signed token
  const { userId, businessId, accountId } = consumed;

  // Validate token bindings match DB state
  if (consumed.provider !== 'stripe') {
    logger.warn('[STRIPE-CALLBACK] Provider mismatch: expected stripe, got', consumed.provider);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=provider_mismatch`);
  }

  // Verify the authenticated user matches the state
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.id !== userId) {
    logger.warn('[STRIPE-CALLBACK] Authenticated user does not match state');
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=user_mismatch`);
  }

  // Verify business ownership via authenticated client (RLS-enforced)
  const { data: bizCheck } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .single();
  if (!bizCheck) {
    logger.warn('[STRIPE-CALLBACK] User does not own business', businessId);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_owner`);
  }

  // All mutations below use service client (bypasses sensitive-field trigger).
  // Auth check above proves ownership; service client is safe here.
  try {
    if (!stripeSecretKey) {
      // Mock mode — deactivate only previous Stripe, preserve others
      const { error: revokeErr } = await service.from('payout_accounts')
        .update({ is_active: false, connection_status: 'revoked', updated_at: new Date().toISOString() })
        .eq('business_id', businessId).eq('gateway', 'stripe').eq('is_active', true);

      if (revokeErr) {
        logger.error('[STRIPE-CALLBACK] Mock revoke error:', revokeErr.message);
        return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=revoke_failed`);
      }

      const { data: mockDefault } = await service.from('payout_accounts')
        .select('id').eq('business_id', businessId).eq('is_default', true)
        .eq('is_active', true).not('verified_at', 'is', null).maybeSingle();

      const { error: mockInsertErr } = await service.from('payout_accounts').insert({
        business_id: businessId, gateway: 'stripe', stripe_account_id: accountId,
        platform_percentage: 2.5, is_active: true, is_default: !mockDefault,
        connection_mode: 'connect', connection_status: 'active',
        health_status: 'healthy', verified_at: new Date().toISOString(),
      });

      if (mockInsertErr) {
        logger.error('[STRIPE-CALLBACK] Mock insert error:', mockInsertErr.message);
        return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=insert_failed`);
      }

      return NextResponse.redirect(`${appUrl}/dashboard/payouts?connected=true`);
    }

    // Verify the account status with Stripe
    const res = await fetch(`https://api.stripe.com/v1/accounts/${encodeURIComponent(accountId)}`, {
      headers: { Authorization: `Bearer ${stripeSecretKey}` },
    });
    const account = await res.json();

    if (!account.charges_enabled) {
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_verified`);
    }

    // Deactivate only previous Stripe connections (preserve other providers)
    const { error: revokeErr } = await service
      .from('payout_accounts')
      .update({ is_active: false, connection_status: 'revoked', updated_at: new Date().toISOString() })
      .eq('business_id', businessId)
      .eq('gateway', 'stripe')
      .eq('is_active', true);

    if (revokeErr) {
      logger.error('[STRIPE-CALLBACK] Revoke error:', revokeErr.message);
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=revoke_failed`);
    }

    // Check if business has an existing valid default
    const { data: existingDefault } = await service
      .from('payout_accounts')
      .select('id')
      .eq('business_id', businessId)
      .eq('is_default', true)
      .eq('is_active', true)
      .not('verified_at', 'is', null)
      .maybeSingle();

    // Save the connected account (service client — sets sensitive fields)
    const { error: insertErr } = await service.from('payout_accounts').insert({
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
    });

    if (insertErr) {
      logger.error('[STRIPE-CALLBACK] Insert error:', insertErr.message);
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=insert_failed`);
    }

    // Auto-set payout_mode to direct_split
    const { error: bizUpdateErr } = await service
      .from('businesses')
      .update({ payout_mode: 'direct_split' })
      .eq('id', businessId);

    if (bizUpdateErr) {
      logger.error('[STRIPE-CALLBACK] Business update error:', bizUpdateErr.message);
      // Non-fatal — connection was created successfully
    }

    return NextResponse.redirect(`${appUrl}/dashboard/payouts?connected=true`);
  } catch (error) {
    logger.error('Stripe callback error:', (error as Error).message);
    return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=callback_failed`);
  }
}
