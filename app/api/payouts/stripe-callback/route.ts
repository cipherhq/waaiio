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

  // Use the DB-stored payload (authoritative)
  const { userId, businessId, accountId } = consumed;

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

  try {
    if (!stripeSecretKey) {
      // Mock mode — use the same transactional RPC
      const { data: mockResult, error: mockRpcErr } = await service.rpc('replace_stripe_connection', {
        p_business_id: businessId,
        p_account_id: accountId,
      });

      if (mockRpcErr) {
        logger.error('[STRIPE-CALLBACK] Mock RPC error:', mockRpcErr.message);
        return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=replace_failed`);
      }

      if (!mockResult?.success) {
        logger.error('[STRIPE-CALLBACK] Mock RPC rejected:', mockResult?.reason);
        return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=${mockResult?.reason || 'replace_failed'}`);
      }

      return NextResponse.redirect(`${appUrl}/dashboard/payouts?connected=true`);
    }

    // Verify the account status with Stripe API
    const res = await fetch(`https://api.stripe.com/v1/accounts/${encodeURIComponent(accountId)}`, {
      headers: { Authorization: `Bearer ${stripeSecretKey}` },
    });
    const account = await res.json();

    if (!account.charges_enabled) {
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=not_verified`);
    }

    // Transactional replacement: revoke old Stripe + insert new in one transaction.
    // On any failure, Postgres rolls back — old connection is never lost.
    const { data: result, error: rpcErr } = await service.rpc('replace_stripe_connection', {
      p_business_id: businessId,
      p_account_id: accountId,
    });

    if (rpcErr) {
      logger.error('[STRIPE-CALLBACK] RPC error:', rpcErr.message);
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=replace_failed`);
    }

    if (!result?.success) {
      logger.error('[STRIPE-CALLBACK] RPC rejected:', result?.reason);
      return NextResponse.redirect(`${appUrl}/dashboard/payouts?error=${result?.reason || 'replace_failed'}`);
    }

    // Non-fatal: update business payout mode
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
